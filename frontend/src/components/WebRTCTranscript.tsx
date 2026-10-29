import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';

interface RealtimeSession {
  id: string;
  client_secret: {
    value: string;
    expires_at: number;
  };
  expires_at: number;
}

export interface TranscriptEntry {
  text: string;
  timestamp: number;  // When speech STARTED (ms since recording start) - for correct ordering
  receiveTimestamp: number;  // When we received the transcription (ms since recording start)
  itemId?: string | null;  // OpenAI's item_id for reference
  speechOrder: number;  // Order based on when speech started (correct chronological order)
}

export interface WebRTCTranscriptRef {
  startRecording: () => void;
  stopRecording: () => void;
  getAudioData: () => {
    audioBlob: Blob | null;
    transcriptWithTimestamps: Array<TranscriptEntry>;
    recordingStartTime: number;
  };
}

interface WebRTCTranscriptProps {
  isPracticeMode?: boolean;
  // Paper 2 (2026-09) test mode: called with the full list of completed transcript chunks
  // (one entry per finished segment, in completion order) every time a new segment completes,
  // so a page-level debug panel can show each chunk on its own line. undefined for the regular
  // participant flow - has no effect there.
  onTranscriptUpdate?: (chunks: string[]) => void;
  // In-progress deltas make it clear in test mode that the stream is still active before a
  // completed chunk is emitted.
  onTranscriptPartialUpdate?: (text: string | null) => void;
  // Reports live microphone activity so process-analysis silence detection is based on audio,
  // not on delayed transcription chunks.
  onSpeechActivity?: (timestamp: number) => void;
  // Paper 2 Phase 2 (2026-09): required so completed transcript segments can be batch-uploaded to
  // speech_segments in near-real-time (see flushPendingSegments below). Both practice and actual
  // pages pass their own sessionId here.
  sessionId: string;
}

// Paper 2 Phase 2: how often to flush queued transcript segments to /api/transcript/segments/batch,
// mirroring useInteractionLogger's default batchInterval.
const SEGMENT_FLUSH_INTERVAL_MS = 5000;
const LOCAL_SILENCE_BREAKPOINT_MS = 500;
const LOCAL_VOICE_RMS_THRESHOLD = 0.015;
// gpt-live-transcribe has no server VAD. Preserve the 500ms local pause boundary, but
// never leave continuous think-aloud speech uncommitted indefinitely when no pause occurs.
const MAX_UNCOMMITTED_SPEECH_MS = 4000;

// Paper 2 (2026-09): mirrors the backend's TRANSCRIPTION_PROMPT in transcript.ts - resent here
// on session.update for the same reason the model/delay fields are resent (belt-and-suspenders
// in case the data channel opens before the backend's /session config is fully applied).
const TRANSCRIPTION_PROMPT =
  'A user is collaborating with an AI chatbot to develop a creative and useful community heat-resilience support system proposal.';

interface PendingSpeechSegment {
  timestampStart: number; // absolute epoch ms - see comment on the backend route for why
  timestampEnd: number; // absolute epoch ms
  transcription: string;
}

const WebRTCTranscript = forwardRef<WebRTCTranscriptRef, WebRTCTranscriptProps>(({ isPracticeMode = false, onTranscriptUpdate, onTranscriptPartialUpdate, onSpeechActivity, sessionId }, ref) => {
  const [isRecording, setIsRecording] = useState(false);
  // Paper 2 (2026-09): kept as an array of completed chunks (not a joined string) so the test
  // mode debug panel can render one line per chunk instead of one run-on paragraph. The array
  // itself is only read inside the setTranscriptChunks updater below (via 'prev'), never in JSX.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [transcriptChunks, setTranscriptChunks] = useState<string[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [isConnecting, setIsConnecting] = useState(false); // Used for connection state management
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [error, setError] = useState<string>('');

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordingStartTimeRef = useRef<number>(0);
  const transcriptWithTimestampsRef = useRef<Array<TranscriptEntry>>([]);
  const lastTranscriptRef = useRef<{text: string, timestamp: number} | null>(null);
  const partialTranscriptsRef = useRef<Map<string, string>>(new Map());
  const lastSpeechActivityCallbackAtRef = useRef(0);

  // Paper 2 Phase 2: queue of completed segments not yet uploaded to speech_segments, and the
  // interval that periodically flushes them (started when the data channel opens, stopped in
  // cleanup()).
  const pendingSegmentsRef = useRef<PendingSpeechSegment[]>([]);
  const segmentFlushIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadAnimationFrameRef = useRef<number | null>(null);
  const hasUncommittedSpeechRef = useRef(false);
  const localSpeechStartOffsetRef = useRef<number | null>(null);
  const lastVoiceDetectedAtRef = useRef<number | null>(null);
  const manualCommitStartQueueRef = useRef<number[]>([]);

  // Track speech start times for correct ordering
  // Key: item_id, Value: timestamp when speech started
  const speechStartTimesRef = useRef<Map<string, number>>(new Map());
  // Counter for speech order (incremented each time speech starts)
  const speechOrderCounterRef = useRef<number>(0);

  const sessionLabel = isPracticeMode ? '[WebRTC-Practice]' : '[WebRTC-Actual]';

  // Paper 2 Phase 2: POST whatever segments are currently queued, then clear the queue. Safe to
  // call even when the queue is empty (no-op) or sessionId is falsy (shouldn't happen in
  // practice, but this component doesn't have a way to force a value at the type level here).
  const flushPendingSegments = React.useCallback(() => {
    if (pendingSegmentsRef.current.length === 0 || !sessionId) return;
    const batch = pendingSegmentsRef.current;
    pendingSegmentsRef.current = [];
    fetch('/api/transcript/segments/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Persist this clock anchor with the batch. Segment timestamps themselves
      // are absolute epoch milliseconds, but the anchor documents and supports
      // correct conversion of any relative-time fallback rows when microphone
      // recording began after the task session.
      body: JSON.stringify({
        sessionId,
        segments: batch,
        recordingStartEpochMs: recordingStartTimeRef.current || null,
      }),
    }).catch((err) => {
      console.error(`${sessionLabel} Failed to upload speech segments:`, err);
    });
  }, [sessionId, sessionLabel]);

  const sendManualAudioCommit = React.useCallback((reason: 'silence' | 'max_duration' | 'cleanup' = 'silence') => {
    const dataChannel = dataChannelRef.current;
    if (
      !hasUncommittedSpeechRef.current ||
      !dataChannel ||
      dataChannel.readyState !== 'open' ||
      !recordingStartTimeRef.current
    ) {
      return;
    }

    const speechStartOffset = localSpeechStartOffsetRef.current ?? Date.now() - recordingStartTimeRef.current;
    const bufferedDurationMs = Date.now() - recordingStartTimeRef.current - speechStartOffset;
    if (bufferedDurationMs < 100) {
      // Realtime rejects empty/tiny commits. It is a harmless local-VAD race, not a
      // participant-facing recording failure.
      hasUncommittedSpeechRef.current = false;
      localSpeechStartOffsetRef.current = null;
      return;
    }
    manualCommitStartQueueRef.current.push(speechStartOffset);
    dataChannel.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));

    hasUncommittedSpeechRef.current = false;
    localSpeechStartOffsetRef.current = null;
    lastVoiceDetectedAtRef.current = null;
    console.log(`${sessionLabel} Manual audio commit sent (${reason})`);
  }, [sessionLabel]);

  const stopLocalSilenceDetection = React.useCallback(() => {
    if (vadAnimationFrameRef.current !== null) {
      cancelAnimationFrame(vadAnimationFrameRef.current);
      vadAnimationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch((err) => {
        console.warn(`${sessionLabel} Failed to close audio context:`, err);
      });
      audioContextRef.current = null;
    }
  }, [sessionLabel]);

  const startLocalSilenceDetection = React.useCallback((stream: MediaStream) => {
    stopLocalSilenceDetection();

    const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextCtor) {
      console.warn(`${sessionLabel} Web Audio API unavailable; realtime transcript chunks may not complete automatically`);
      return;
    }

    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    audioContextRef.current = audioContext;

    // Recording is started automatically when the task page loads. Some browsers create an
    // AudioContext in the suspended state outside a direct user gesture, which leaves the VAD
    // analyser reading silence forever. Resume it explicitly and retain the max-duration guard
    // below for environments that still restrict local audio analysis.
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch((err: unknown) => {
        console.warn(`${sessionLabel} Local VAD audio context could not resume:`, err);
      });
    }

    const samples = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);

      let sumSquares = 0;
      for (let i = 0; i < samples.length; i += 1) {
        const centered = (samples[i] - 128) / 128;
        sumSquares += centered * centered;
      }

      const rms = Math.sqrt(sumSquares / samples.length);
      const now = Date.now();
      const offset = now - recordingStartTimeRef.current;

      if (rms >= LOCAL_VOICE_RMS_THRESHOLD) {
        if (now - lastSpeechActivityCallbackAtRef.current >= 250) {
          lastSpeechActivityCallbackAtRef.current = now;
          onSpeechActivity?.(now);
        }
        if (!hasUncommittedSpeechRef.current) {
          hasUncommittedSpeechRef.current = true;
          localSpeechStartOffsetRef.current = offset;
          console.log(`${sessionLabel} Local speech started at ${offset}ms`);
        }
        lastVoiceDetectedAtRef.current = now;
        if (
          hasUncommittedSpeechRef.current &&
          localSpeechStartOffsetRef.current !== null &&
          offset - localSpeechStartOffsetRef.current >= MAX_UNCOMMITTED_SPEECH_MS
        ) {
          sendManualAudioCommit('max_duration');
        }
      } else if (
        hasUncommittedSpeechRef.current &&
        lastVoiceDetectedAtRef.current !== null &&
        now - lastVoiceDetectedAtRef.current >= LOCAL_SILENCE_BREAKPOINT_MS
      ) {
        sendManualAudioCommit('silence');
      }

      vadAnimationFrameRef.current = requestAnimationFrame(tick);
    };

    tick();
  }, [onSpeechActivity, sendManualAudioCommit, sessionLabel, stopLocalSilenceDetection]);

  // Log component mount/unmount
  useEffect(() => {
    console.log(`${sessionLabel} Component mounted`);
    return () => {
      console.log(`${sessionLabel} Component unmounting - triggering cleanup`);
    };
  }, [sessionLabel]);

  // Create session and establish WebRTC connection
  const createRealtimeSession = async () => {
    try {
      console.log(`${sessionLabel} Starting new recording session...`);

      // CRITICAL: Check if there's already an active session
      if (peerConnectionRef.current || mediaRecorderRef.current) {
        console.warn(`${sessionLabel} Found existing session - cleaning up first`);
        cleanup();
        // Wait a bit for cleanup to complete
        await new Promise(resolve => setTimeout(resolve, 200));
      }

      setIsConnecting(true);
      setConnectionStatus('connecting');
      setError('');
      hasUncommittedSpeechRef.current = false;
      localSpeechStartOffsetRef.current = null;
      lastVoiceDetectedAtRef.current = null;
      manualCommitStartQueueRef.current = [];

      // Step 1: Create OpenAI Realtime session
      console.log(`${sessionLabel} Creating OpenAI Realtime session...`);
      const response = await fetch('/api/transcript/session', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: ${response.status}`);
      }

      const { session, model } = await response.json();
      sessionRef.current = session;
      console.log(`${sessionLabel} Session created:`, session.id, 'Model:', model);

      // Step 2: Set up WebRTC peer connection
      const peerConnection = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
      });

      peerConnectionRef.current = peerConnection;

      // Step 3: Set up data channel for receiving transcription
      const dataChannel = peerConnection.createDataChannel('transcript', {
        ordered: true,
      });

      dataChannelRef.current = dataChannel;

      dataChannel.onopen = () => {
        console.log(`${sessionLabel} Data channel opened`);
        setConnectionStatus('connected');

        // Paper 2 Phase 2: start periodically flushing completed transcript segments to the
        // backend. Cleared in cleanup() below.
        if (segmentFlushIntervalRef.current) {
          clearInterval(segmentFlushIntervalRef.current);
        }
        segmentFlushIntervalRef.current = setInterval(flushPendingSegments, SEGMENT_FLUSH_INTERVAL_MS);

        // Send session update to (re)confirm transcription model + realtime transcription settings.
        // GA schema (2026-09 migration off gpt-4o-realtime-preview/whisper-1): session config now
        // nests under session.audio.input instead of top-level input_audio_transcription/turn_detection.
        // This is already baked into the ephemeral client secret by the backend's /session call, but
        // we resend it here too in case the data channel opens before that config is fully applied.
        // Paper 2 (2026-09): use whatever model the backend's /session call actually configured
        // (destructured as 'model' above) rather than hardcoding a model name here - otherwise
        // changing OPENAI_REALTIME_MODEL on the backend alone would silently desync this
        // resend-on-open confirmation from the model actually baked into the ephemeral client
        // secret. gpt-live-transcribe uses delay: 'low' for faster deltas. This platform's API
        // rejects turn_detection for gpt-live-transcribe, so browser-side silence detection commits
        // buffered audio after 500ms of local silence.
        dataChannel.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'transcription',
            audio: {
              input: {
                transcription: {
                  model: model,
                  prompt: TRANSCRIPTION_PROMPT,
                  delay: 'low'
                },
                turn_detection: null
              }
            }
          }
        }));
        console.log(`${sessionLabel} Session update sent - ${model} with low delay and local 500ms silence commits confirmed`);
      };

      dataChannel.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);

          // Track when speech STARTS - this gives us the correct chronological order
          if (message.type === 'input_audio_buffer.speech_started') {
            const speechStartTime = Date.now() - recordingStartTimeRef.current;
            speechOrderCounterRef.current += 1;
            const currentOrder = speechOrderCounterRef.current;

            // Store the speech start time with current order as key (item_id comes later)
            // We'll use a temporary key based on order since item_id isn't available yet
            const tempKey = `pending_${currentOrder}`;
            speechStartTimesRef.current.set(tempKey, speechStartTime);

            console.log(`${sessionLabel} Speech started at ${speechStartTime}ms, order: ${currentOrder}`);
          }

          // Track when speech STOPS - we can now associate item_id with the speech
          if (message.type === 'input_audio_buffer.speech_stopped') {
            const itemId = message.item_id;
            if (itemId) {
              // Find the most recent pending speech start and associate it with this item_id
              const pendingKeys = Array.from(speechStartTimesRef.current.keys())
                .filter(k => k.startsWith('pending_'))
                .sort((a, b) => parseInt(a.split('_')[1]) - parseInt(b.split('_')[1]));

              if (pendingKeys.length > 0) {
                const oldestPendingKey = pendingKeys[0];
                const speechStartTime = speechStartTimesRef.current.get(oldestPendingKey);
                if (speechStartTime !== undefined) {
                  // Move from pending key to item_id key
                  speechStartTimesRef.current.delete(oldestPendingKey);
                  speechStartTimesRef.current.set(itemId, speechStartTime);
                  console.log(`${sessionLabel} Speech stopped, item_id: ${itemId}, started at: ${speechStartTime}ms`);
                }
              }
            }
          }

          if (message.type === 'input_audio_buffer.committed' && message.item_id) {
            const speechStartTime = manualCommitStartQueueRef.current.shift();
            if (speechStartTime !== undefined) {
              speechStartTimesRef.current.set(message.item_id, speechStartTime);
              console.log(`${sessionLabel} Manual commit item_id: ${message.item_id}, started at: ${speechStartTime}ms`);
            }
          }

          if (message.type === 'conversation.item.input_audio_transcription.delta') {
            const itemId = message.item_id || 'in_progress';
            const delta = typeof message.delta === 'string' ? message.delta : '';
            if (delta) {
              const updated = `${partialTranscriptsRef.current.get(itemId) || ''}${delta}`;
              partialTranscriptsRef.current.set(itemId, updated);
              onTranscriptPartialUpdate?.(updated);
            }
          }

          // Handle transcription completion
          if (message.type === 'conversation.item.input_audio_transcription.completed') {
            const transcriptText = message.transcript;
            const receiveTimestamp = Date.now() - recordingStartTimeRef.current;
            const itemId = message.item_id;

            if (itemId) partialTranscriptsRef.current.delete(itemId);
            const remainingPartials = Array.from(partialTranscriptsRef.current.values());
            onTranscriptPartialUpdate?.(remainingPartials.length ? remainingPartials[remainingPartials.length - 1] : null);

            // Get the speech start time for this item (for correct ordering)
            const speechStartTime = itemId ? speechStartTimesRef.current.get(itemId) : null;

            // Deduplication: Check if this is a duplicate of the last transcript
            const isDuplicate = lastTranscriptRef.current &&
              lastTranscriptRef.current.text === transcriptText &&
              Math.abs(lastTranscriptRef.current.timestamp - receiveTimestamp) < 1000; // Within 1 second

            if (!isDuplicate) {
              // Not a duplicate, save it
              setTranscriptChunks(prev => {
                const updated = [...prev, transcriptText];
                onTranscriptUpdate?.(updated);
                return updated;
              });

              // Paper 2 Phase 2: queue this segment for near-real-time upload to speech_segments.
              // Converted to absolute epoch ms (recordingStartTimeRef is itself a Date.now()
              // snapshot from when recording started) - see the backend route's comment on why
              // absolute rather than relative-to-session-start.
              pendingSegmentsRef.current.push({
                timestampStart: recordingStartTimeRef.current + (speechStartTime ?? receiveTimestamp),
                timestampEnd: recordingStartTimeRef.current + receiveTimestamp,
                transcription: transcriptText,
              });
              flushPendingSegments();

              // Determine speech order based on when this speech actually started
              // If we have the speech start time, find its order; otherwise use receive order
              let speechOrder = transcriptWithTimestampsRef.current.length;
              if (speechStartTime !== undefined && speechStartTime !== null) {
                // Count how many existing entries have earlier speech start times
                const startTime = speechStartTime; // TypeScript narrowing
                speechOrder = transcriptWithTimestampsRef.current.filter(
                  entry => entry.timestamp < startTime
                ).length;
              }

              const entry: TranscriptEntry = {
                text: transcriptText,
                timestamp: speechStartTime ?? receiveTimestamp,  // Use speech start time if available
                receiveTimestamp: receiveTimestamp,
                itemId: itemId || null,
                speechOrder: speechOrder
              };

              transcriptWithTimestampsRef.current.push(entry);

              // Re-sort by timestamp (speech start time) to maintain correct order
              transcriptWithTimestampsRef.current.sort((a, b) => a.timestamp - b.timestamp);

              // Update speech order after sorting
              transcriptWithTimestampsRef.current.forEach((e, idx) => {
                e.speechOrder = idx;
              });

              // Update last transcript reference
              lastTranscriptRef.current = { text: transcriptText, timestamp: receiveTimestamp };

              // Clean up the speech start time entry
              if (itemId) {
                speechStartTimesRef.current.delete(itemId);
              }
            }
          } else if (message.type === 'error') {
            console.error(`${sessionLabel} OpenAI error:`, message);
            const errorMessage = message.error?.message || 'Unknown error from OpenAI';
            if (/committing input audio buffer: buffer too small/i.test(errorMessage)) {
              console.warn(`${sessionLabel} Ignoring nonfatal short audio-buffer commit.`);
            } else {
              setError(errorMessage);
            }
          }
          // Log other message types for debugging (but not the common ones)
          else if (!['session.created', 'session.updated', 'input_audio_buffer.speech_started', 'input_audio_buffer.speech_stopped', 'input_audio_buffer.committed', 'conversation.item.created', 'response.created', 'response.done', 'conversation.item.input_audio_transcription.delta'].includes(message.type)) {
            console.log(`${sessionLabel} Received message type:`, message.type);
          }
        } catch (error) {
          console.error(`${sessionLabel} Error parsing message:`, error);
        }
      };

      dataChannel.onerror = (error) => {
        console.error('Data channel error:', error);
        setError('Data channel error occurred');
      };

      dataChannel.onclose = () => {
        setConnectionStatus('disconnected');
      };

      // Step 4: Get user media (microphone)
      // Check if mediaDevices is available (requires HTTPS in production)
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access requires HTTPS. Please use a secure connection.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      mediaStreamRef.current = stream;

      // Start recording audio for later save
      try {
        const mediaRecorder = new MediaRecorder(stream, {
          mimeType: 'audio/webm'
        });

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.start(1000); // Collect data every second
        mediaRecorderRef.current = mediaRecorder;
        recordingStartTimeRef.current = Date.now();
        startLocalSilenceDetection(stream);
        console.log(`${sessionLabel} Started audio recording for file save`);
      } catch (recorderError) {
        console.error('Failed to start MediaRecorder:', recorderError);
      }

      // Step 5: Add audio track to peer connection
      stream.getAudioTracks().forEach((track) => {
        peerConnection.addTrack(track, stream);
      });

      // Step 6: Create offer and set up connection
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      // Step 7: Connect to OpenAI Realtime API via backend proxy (CORS fix)
      const connectResponse = await fetch('/api/transcript/realtime-connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sdp: offer.sdp,
          clientSecret: session.client_secret.value
        }),
      });

      if (!connectResponse.ok) {
        throw new Error(`Failed to connect to WebRTC: ${connectResponse.status}`);
      }

      const answerSdp = await connectResponse.text();

      // Set remote description
      await peerConnection.setRemoteDescription(new RTCSessionDescription({
        type: 'answer',
        sdp: answerSdp,
      }));

      console.log(`${sessionLabel} WebRTC connection established successfully`);
      setIsRecording(true);
      setIsConnecting(false);

    } catch (error) {
      console.error(`${sessionLabel} Failed to create realtime session:`, error);
      setError(error instanceof Error ? error.message : 'Failed to start recording');
      setIsConnecting(false);
      setConnectionStatus('disconnected');
      cleanup();
    }
  };

  const cleanup = useCallback(() => {
    console.log(`${sessionLabel} Cleaning up session...`);

    // Paper 2 Phase 2: stop the periodic flush and send whatever's still queued, so the last few
    // seconds of a recording aren't silently dropped when the session ends.
    if (segmentFlushIntervalRef.current) {
      clearInterval(segmentFlushIntervalRef.current);
      segmentFlushIntervalRef.current = null;
    }
    flushPendingSegments();

    sendManualAudioCommit('cleanup');
    stopLocalSilenceDetection();

    // Stop media recorder
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }

    // Close data channel
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    // Close peer connection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    // Stop media stream (microphone)
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Reset deduplication reference
    lastTranscriptRef.current = null;
    partialTranscriptsRef.current.clear();
    onTranscriptPartialUpdate?.(null);

    setConnectionStatus('disconnected');
    sessionRef.current = null;
  }, [sessionLabel, flushPendingSegments, onTranscriptPartialUpdate, sendManualAudioCommit, stopLocalSilenceDetection]);

  const stopRecording = useCallback(() => {
    console.log(`${sessionLabel} Stopping recording...`);
    setIsRecording(false);
    cleanup();
  }, [cleanup, sessionLabel]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected': return '#22c55e';
      case 'connecting': return '#f59e0b';
      default: return '#ef4444';
    }
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case 'connected': return 'Connected';
      case 'connecting': return 'Connecting...';
      default: return 'Disconnected';
    }
  };

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    startRecording: createRealtimeSession,
    stopRecording: stopRecording,
    getAudioData: () => {
      // Create audio blob from chunks
      const audioBlob = audioChunksRef.current.length > 0
        ? new Blob(audioChunksRef.current, { type: 'audio/webm' })
        : null;

      return {
        audioBlob,
        transcriptWithTimestamps: transcriptWithTimestampsRef.current,
        recordingStartTime: recordingStartTimeRef.current
      };
    }
  }));

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', padding: '0.75rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: '0.5rem' }}>
        <div style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          backgroundColor: getStatusColor()
        }}></div>
        <span style={{ fontSize: '0.75rem', color: getStatusColor() }}>
          {getStatusText()}
        </span>
      </div>

      {/* Error Display */}
      {error && (
        <div style={{
          marginTop: '0.5rem',
          padding: '0.5rem',
          backgroundColor: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '0.5rem',
          color: '#b91c1c',
          fontSize: '0.75rem'
        }}>
          {error}
        </div>
      )}

      {/* Recording Info - Show when recording is active */}
      {isRecording && (
        <div style={{
          marginTop: '0.5rem',
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          padding: '0.5rem',
          backgroundColor: '#f0f9ff',
          border: '1px solid #bae6fd',
          borderRadius: '0.5rem'
        }}>
          <div style={{
            height: '0.5rem',
            width: '0.5rem',
            backgroundColor: '#3b82f6',
            borderRadius: '50%',
            animation: 'pulse 2s infinite'
          }}></div>
          <span style={{ color: '#1e40af', fontSize: '0.75rem', fontWeight: '500' }}>
            Audio recording active - speak naturally
          </span>
        </div>
      )}

      {/* CSS for animations */}
      <style>
        {`
          @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
          }
        `}
      </style>
    </div>
  );
});

WebRTCTranscript.displayName = 'WebRTCTranscript';

export default WebRTCTranscript;
