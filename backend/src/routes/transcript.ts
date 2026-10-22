import express, { Request } from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';
import { buildSessionTimeline } from '../services/eventTimelineBuilder';
import {
  inspectSessionMetadata,
  sessionMetadataDiagnostic,
  sessionMetadataErrorSummary,
} from '../services/sessionMetadataDiagnostics';

// Extend Request type to include file
interface MulterRequest extends Request {
  file?: Express.Multer.File;
  db?: any;
}

const router = express.Router();

// LOCAL DIAGNOSTICS ONLY — set TIMELINE_DIAGNOSTICS=false before pushing/deploying.
// Read at request time because dotenv is initialized after route modules load.
function timelineDiagnosticsEnabled(): boolean {
  return process.env.TIMELINE_DIAGNOSTICS === 'true';
}

function diagnosticErrorSummary(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { value: String(error) };
  const mysqlError = error as Error & { code?: unknown; errno?: unknown; sqlState?: unknown; sqlMessage?: unknown };
  return {
    name: mysqlError.name,
    message: mysqlError.message,
    code: mysqlError.code,
    errno: mysqlError.errno,
    sqlState: mysqlError.sqlState,
    sqlMessage: mysqlError.sqlMessage,
  };
}

function transcriptDiagnostic(payload: Record<string, unknown>): void {
  if (!timelineDiagnosticsEnabled()) return;
  // Deliberately omit transcription, chat, interaction text, and full metadata.
  console.info('[TRANSCRIPT_DIAGNOSTIC]', JSON.stringify({ at: new Date().toISOString(), ...payload }));
}

function speechBatchSummary(segments: unknown[]): Record<string, unknown> {
  const starts: number[] = [];
  const ends: number[] = [];
  let transcriptCharTotal = 0;
  let transcriptCharMaximum = 0;
  for (const segment of segments as any[]) {
    const start = Number(segment?.timestampStart);
    const end = Number(segment?.timestampEnd);
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(end)) ends.push(end);
    const length = typeof segment?.transcription === 'string' ? segment.transcription.length : 0;
    transcriptCharTotal += length;
    transcriptCharMaximum = Math.max(transcriptCharMaximum, length);
  }
  return {
    segmentCount: segments.length,
    timestampStartMinimum: starts.length ? Math.min(...starts) : null,
    timestampEndMaximum: ends.length ? Math.max(...ends) : null,
    transcriptCharTotal,
    transcriptCharMaximum,
  };
}

async function sessionMetadataSummary(db: any, sessionId: string): Promise<Record<string, unknown>> {
  return inspectSessionMetadata(db, sessionId);
}

// Lazy initialize OpenAI client to ensure .env is loaded
function getOpenAI() {
  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

// Store active realtime connections
const realtimeConnections = new Map<string, WebSocket>();

// Configure multer for audio file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit (increased for longer recordings)
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'audio/mpeg',
      'audio/mp4',
      'audio/mp3',
      'audio/wav',
      'audio/webm',
      'audio/ogg'
    ];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid audio file type'));
    }
  }
});

// POST /api/transcript/session - Create OpenAI Realtime *transcription* session (GA client_secrets API)
//
// Paper 2 (2026-09): migrated off the deprecated /v1/realtime/sessions + gpt-4o-realtime-preview
// stack. Current API: POST /v1/realtime/client_secrets returns an ephemeral client secret whose
// session config (model, transcription, VAD) is baked in server-side; the frontend then uses that
// secret directly against /v1/realtime/calls (see /realtime-connect below) — no more passing `model`
// on the WebRTC call itself.
// Paper 2 (2026-09): gpt-live-transcribe rejects session.audio.input.turn_detection on this
// platform, so turn detection is disabled server-side. The browser runs a small local silence
// detector and manually commits each audio chunk after 500ms of silence.
const TRANSCRIPTION_PROMPT =
  'A user is collaborating with an AI chatbot to create a helpful, creative career-development learning platform proposal for adults.';

router.post('/session', async (req, res) => {
  try {
    console.log('Creating new OpenAI Realtime transcription session...');

    const transcriptionModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-live-transcribe';

    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: {
                model: transcriptionModel,
                prompt: TRANSCRIPTION_PROMPT,
                delay: "low",
              },
              turn_detection: null,
            },
          },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI API error:', response.status, errorText);
      throw new Error(`OpenAI API error: ${response.status} ${errorText}`);
    }

    const data: any = await response.json();

    // OpenAI's docs did not render a fully pinned-down response shape for this GA endpoint at the
    // time this was written, so parse defensively: support both a top-level `value`/`expires_at`
    // and a nested `client_secret.value`/`client_secret.expires_at`.
    const clientSecretValue = data.value ?? data.client_secret?.value;
    const clientSecretExpiresAt = data.expires_at ?? data.client_secret?.expires_at;

    if (!clientSecretValue) {
      console.error('Unexpected /v1/realtime/client_secrets response shape:', JSON.stringify(data));
      throw new Error('OpenAI client_secrets response did not include a client secret value');
    }

    // Reshape into what the frontend (WebRTCTranscript.tsx) already expects:
    // { id, client_secret: { value, expires_at }, expires_at }
    const session = {
      id: data.session?.id ?? data.id ?? `sess_${Date.now()}`,
      client_secret: {
        value: clientSecretValue,
        expires_at: clientSecretExpiresAt,
      },
      expires_at: clientSecretExpiresAt,
    };

    console.log('OpenAI Realtime transcription session created:', session.id);

    res.json({
      session,
      model: transcriptionModel,  // Pass model to frontend
      status: 'session_created',
      message: 'OpenAI Realtime transcription session created for WebRTC'
    });

  } catch (error) {
    console.error('Failed to create realtime session:', error);
    res.status(500).json({
      error: 'Failed to create realtime session',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/transcript/realtime-connect - Proxy WebRTC connection to OpenAI (CORS fix)
router.post('/realtime-connect', async (req, res) => {
  try {
    const { sdp, clientSecret } = req.body;

    if (!sdp || !clientSecret) {
      return res.status(400).json({
        error: 'Missing required fields: sdp and clientSecret are required'
      });
    }

    console.log('Proxying WebRTC connection to OpenAI Realtime API (GA /calls endpoint)...');

    // GA API: no ?model= query param anymore — the model is already baked into the ephemeral
    // client secret's session config from /v1/realtime/client_secrets (see /session above).
    const realtimeUrl = 'https://api.openai.com/v1/realtime/calls';

    const response = await fetch(realtimeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${clientSecret}`,
        'Content-Type': 'application/sdp',
      },
      body: sdp,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenAI WebRTC connection failed:', response.status, errorText);
      throw new Error(`OpenAI WebRTC connection failed: ${response.status} ${errorText}`);
    }

    // Get the SDP answer from OpenAI
    const answerSdp = await response.text();
    console.log('WebRTC connection established successfully through proxy');

    // Return the SDP answer to the client
    res.setHeader('Content-Type', 'application/sdp');
    res.send(answerSdp);

  } catch (error) {
    console.error('Failed to proxy WebRTC connection:', error);
    res.status(500).json({
      error: 'Failed to establish WebRTC connection',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Legacy endpoints for backward compatibility - these will be replaced by WebRTC
router.post('/realtime-audio', (req, res) => {
  res.status(410).json({
    error: 'Endpoint deprecated. Use WebRTC connection directly to OpenAI.',
    message: 'Please create a session via /session endpoint and connect directly to OpenAI'
  });
});

router.post('/realtime-stop', (req, res) => {
  res.status(410).json({
    error: 'Endpoint deprecated. WebRTC sessions are managed client-side.',
    message: 'Sessions will automatically expire or can be closed client-side'
  });
});

// POST /api/transcript/segments/batch - Paper 2 Phase 2: batch-upload completed speech segments
// to `speech_segments` in near-real-time. Mirrors useInteractionLogger's batching pattern
// (WebRTCTranscript.tsx queues completed transcript segments and flushes every few seconds, plus
// once more on stop/unmount) so the transcript is available in the DB incrementally instead of
// only existing in the browser until final submission export. Used for both practice and actual
// sessions - practice transcripts get the same real-time upload, just tagged with a
// `practice_...` session id.
//
// Timestamp convention (2026-09, worth flagging for Phase 3's eventTimelineBuilder): these are
// ABSOLUTE epoch milliseconds (Date.now()-based), computed client-side as
// recordingStartTime + the relative offset WebRTCTranscript already tracks internally.
// `interaction_logs.timestamp`, by contrast, stores RELATIVE milliseconds since session start
// (see routes/logging.ts). Phase 3 will need to normalize between the two conventions when
// merging speech into the unified event timeline - e.g. by adding sessionStartTime to a relative
// value, or subtracting it from an absolute one - rather than assuming they're already aligned.
router.post('/segments/batch', async (req: MulterRequest, res) => {
  const traceId = `speech-${Date.now()}-${uuidv4().slice(0, 8)}`;
  try {
    const { sessionId, segments, recordingStartEpochMs } = req.body;
    const db = req.db;

    transcriptDiagnostic({
      traceId,
      stage: 'request_received',
      sessionId: typeof sessionId === 'string' ? sessionId : null,
      contentLength: req.headers['content-length'] ?? null,
      recordingStartType: typeof recordingStartEpochMs,
      recordingStartStringLength: typeof recordingStartEpochMs === 'string' ? recordingStartEpochMs.length : null,
      recordingStartIsFinite: Number.isFinite(Number(recordingStartEpochMs)),
      recordingStartNumeric: Number.isFinite(Number(recordingStartEpochMs)) ? Number(recordingStartEpochMs) : null,
      ...(Array.isArray(segments) ? speechBatchSummary(segments) : { segmentCount: null }),
    });

    if (!sessionId || !Array.isArray(segments)) {
      return res.status(400).json({ error: 'sessionId and segments array are required' });
    }
    if (segments.length === 0) {
      return res.json({ success: true, count: 0 });
    }
    if (!db) {
      return res.json({ success: true, count: 0, message: 'Demo mode: not saved to database' });
    }

    // Defensive auto-create, mirroring routes/logging.ts - speech_segments has a foreign key on
    // sessions(id), and this endpoint can in principle be called before /api/session/create's
    // insert has committed (network reordering, retries, etc.).
    try {
      const [existingSessions] = await db.execute('SELECT id FROM sessions WHERE id = ?', [sessionId]);
      if ((existingSessions as any[]).length === 0) {
        console.log(`[Transcript] Session ${sessionId} not found, creating it...`);
        sessionMetadataDiagnostic({
          traceId,
          stage: 'auto_create_before',
          source: 'transcript_batch',
          sessionId,
          metadata: await sessionMetadataSummary(db, sessionId),
        });
        const [autoCreateResult] = await db.execute(
          'INSERT INTO sessions (id, participant_id, status) VALUES (?, ?, ?)',
          [sessionId, 'auto-created', 'active']
        );
        sessionMetadataDiagnostic({
          traceId,
          stage: 'auto_create_after',
          source: 'transcript_batch',
          sessionId,
          result: autoCreateResult,
          metadata: await sessionMetadataSummary(db, sessionId),
        });
      }
    } catch (sessionError) {
      console.error('[Transcript] Error checking/creating session:', sessionError);
      // Continue anyway - will fail on the foreign key below if there's a real issue.
    }

    // interaction_logs and chat history are anchored to the task's session
    // clock. Speech rows are already sent as absolute epoch times, and this
    // additional anchor records the (often later) microphone-start offset for
    // auditability and for legacy relative-timestamp conversion in the timeline
    // materializer. Persist only a missing or malformed value. In particular,
    // never pass JSON_EXTRACT(existing value) back through JSON_SET: MySQL can
    // treat that JSON value as a string and add another escaping layer on every
    // speech batch, causing exponential metadata growth.
    const recordingStart = Number(recordingStartEpochMs);
    if (Number.isFinite(recordingStart) && recordingStart > 0) {
      const metadataBefore = await sessionMetadataSummary(db, sessionId);
      transcriptDiagnostic({ traceId, stage: 'before_recording_anchor_update', sessionId, metadata: metadataBefore });
      sessionMetadataDiagnostic({
        traceId,
        stage: 'recording_anchor_write_before',
        sessionId,
        operation: 'JSON_SET write request anchor only when the stored value is missing or non-integer',
        requestedRecordingStartEpochMs: recordingStart,
        metadata: metadataBefore,
      });
      try {
        const [anchorUpdateResult] = await db.execute(
          `UPDATE sessions
           SET metadata = JSON_SET(COALESCE(metadata, JSON_OBJECT()), '$.recordingStartEpochMs', CAST(? AS UNSIGNED))
           WHERE id = ?
             AND (
               JSON_CONTAINS_PATH(COALESCE(metadata, JSON_OBJECT()), 'one', '$.recordingStartEpochMs') = 0
               OR JSON_TYPE(JSON_EXTRACT(metadata, '$.recordingStartEpochMs')) <> 'INTEGER'
             )`,
          [recordingStart, sessionId]
        );
        const metadataAfter = await sessionMetadataSummary(db, sessionId);
        transcriptDiagnostic({ traceId, stage: 'recording_anchor_updated', sessionId, metadata: metadataAfter });
        sessionMetadataDiagnostic({
          traceId,
          stage: 'recording_anchor_write_after',
          sessionId,
          operation: 'JSON_SET write request anchor only when the stored value is missing or non-integer',
          requestedRecordingStartEpochMs: recordingStart,
          result: anchorUpdateResult,
          metadata: metadataAfter,
        });
      } catch (anchorError) {
        transcriptDiagnostic({
          traceId,
          stage: 'recording_anchor_update_failed',
          sessionId,
          recordingStart,
          metadata: await sessionMetadataSummary(db, sessionId),
          error: diagnosticErrorSummary(anchorError),
        });
        sessionMetadataDiagnostic({
          traceId,
          stage: 'recording_anchor_write_failed',
          sessionId,
          requestedRecordingStartEpochMs: recordingStart,
          metadata: await sessionMetadataSummary(db, sessionId),
          error: sessionMetadataErrorSummary(anchorError),
        });
        throw anchorError;
      }
    }

    const values = segments.map((seg: any) => [
      sessionId,
      seg.timestampStart ?? 0,
      seg.timestampEnd ?? 0,
      seg.transcription || '',
    ]);
    const placeholders = values.map(() => '(?, ?, ?, ?)').join(', ');
    const flatValues = values.flat();

    await db.execute(
      `INSERT INTO speech_segments (session_id, timestamp_start, timestamp_end, transcription)
       VALUES ${placeholders}`,
      flatValues
    );
    transcriptDiagnostic({ traceId, stage: 'speech_segments_inserted', sessionId, insertedSegmentCount: values.length });

    try {
      await buildSessionTimeline(db, sessionId, { traceId, origin: 'transcript_batch' });
    } catch (timelineError) {
      console.error(`Failed to refresh session event timeline after speech upload [${traceId}]:`, timelineError);
    }

    res.json({ success: true, count: values.length, traceId: timelineDiagnosticsEnabled() ? traceId : undefined });

  } catch (error) {
    console.error(`Speech segment batch upload error [${traceId}]:`, error);
    res.status(500).json({
      error: 'Failed to save speech segments',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/transcript/transcribe-chunk - Transcribe audio using OpenAI Whisper (fallback)
router.post('/transcribe-chunk', upload.single('audio'), async (req: MulterRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Create temporary file for OpenAI API
    const tempFilename = `temp_audio_chunk_${uuidv4()}.webm`;
    const tempPath = path.join(__dirname, '../../uploads', tempFilename);

    // Ensure uploads directory exists
    const uploadsDir = path.dirname(tempPath);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Write buffer to temporary file
    fs.writeFileSync(tempPath, req.file.buffer);

    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      language: "en"
    });

    // Clean up temporary file
    fs.unlinkSync(tempPath);
    res.json({ text: transcription.text });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Chunk transcription failed' });
  }
});


// POST /api/transcript/transcribe - Transcribe audio using OpenAI Whisper
router.post('/transcribe', upload.single('audio'), async (req: MulterRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    // Create temporary file for OpenAI API
    const tempFilename = `temp_audio_${uuidv4()}.webm`;
    const tempPath = path.join(__dirname, '../../uploads', tempFilename);

    // Ensure uploads directory exists
    const uploadsDir = path.dirname(tempPath);
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    // Write buffer to temporary file
    fs.writeFileSync(tempPath, req.file.buffer);

    // Transcribe with OpenAI Whisper
    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      language: "en", // Can be made configurable
      response_format: "text"
    });

    // Clean up temporary file
    fs.unlinkSync(tempPath);

    res.json({
      text: transcription,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({
      error: 'Transcription failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/transcript/save - Save transcript to database
router.post('/save', async (req: MulterRequest, res) => {
  try {
    const { content, timestamp } = req.body;
    const sessionId = 'current'; // For now, using default session
    const db = req.db;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    // Generate unique ID for transcript
    const transcriptId = uuidv4();

    // Insert or update transcript in database
    // First try to update existing transcript for this session
    const [updateResult] = await db.execute(
      `UPDATE transcripts SET content = ?, updated_at = NOW()
       WHERE session_id = ?`,
      [content, sessionId]
    );

    // If no rows were updated, insert new transcript
    if ((updateResult as any).affectedRows === 0) {
      await db.execute(
        `INSERT INTO transcripts (id, session_id, content, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [transcriptId, sessionId, content]
      );
    }

    res.json({
      success: true,
      transcriptId: transcriptId,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Save transcript error:', error);
    res.status(500).json({
      error: 'Failed to save transcript',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/transcripts/current - Get current session transcript
router.get('/current', async (req: MulterRequest, res) => {
  try {
    const sessionId = 'current'; // Default session for now
    const db = req.db;

    const [rows] = await db.execute(
      'SELECT content, created_at FROM transcripts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
      [sessionId]
    );

    if ((rows as any[]).length === 0) {
      return res.json({ content: '', timestamp: null });
    }

    const transcript = (rows as any[])[0];
    res.json({
      content: transcript.content,
      timestamp: transcript.created_at,
    });

  } catch (error) {
    console.error('Get current transcript error:', error);
    res.status(500).json({
      error: 'Failed to retrieve current transcript',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/transcripts/:sessionId - Get transcript for a specific session
router.get('/:sessionId', async (req: MulterRequest, res) => {
  try {
    const { sessionId } = req.params;
    const db = req.db;

    const [rows] = await db.execute(
      'SELECT content, created_at FROM transcripts WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1',
      [sessionId]
    );

    if ((rows as any[]).length === 0) {
      return res.json({ content: '', timestamp: null });
    }

    const transcript = (rows as any[])[0];
    res.json({
      content: transcript.content,
      timestamp: transcript.created_at,
    });

  } catch (error) {
    console.error('Get transcript error:', error);
    res.status(500).json({
      error: 'Failed to retrieve transcript',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
