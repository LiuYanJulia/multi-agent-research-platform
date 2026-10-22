import React, { useState, useRef, useEffect } from 'react';
import ChatInterface from '../components/ChatInterface';
import WebRTCTranscript, { WebRTCTranscriptRef } from '../components/WebRTCTranscript';
import DebugPanel, { AgentStageEvent } from '../components/DebugPanel';
import WritingSection from '../components/WritingSection';
import Timer from '../components/Timer';
import SubmissionConfirmation from '../components/SubmissionConfirmation';
import TimeWarningPopup from '../components/TimeWarningPopup';
import { useInteractionLogger } from '../hooks/useInteractionLogger';
import '../App.css';

interface ResearchPageActualProps {
  sessionId: string;
  sessionStartTime: number;
  userId: string;
}

const ResearchPageActual: React.FC<ResearchPageActualProps> = ({
  sessionId,
  sessionStartTime,
  userId
}) => {
  // Initialize logger only when this page is mounted
  const logger = useInteractionLogger({
    sessionId: sessionId,
    sessionStartTime: sessionStartTime,
    batchSize: 50,
    batchInterval: 5000,
  });
  // The wall-clock session start is still useful for restoring an older session,
  // but active time is persisted separately so time spent reading a modal is never
  // added back after a refresh.
  const elapsedStorageKey = `research-platform:actual-active-elapsed:${sessionId}`;
  const writingPhaseStorageKey = `research-platform:actual-writing-phase-start:${sessionId}`;
  const [initialElapsedSeconds] = useState(() => {
    const wallClockFallback = sessionStartTime
      ? Math.max(0, Math.floor((Date.now() - sessionStartTime) / 1000))
      : 0;

    if (typeof window === 'undefined') return wallClockFallback;
    const storedValue = window.localStorage.getItem(elapsedStorageKey);
    const stored = storedValue === null ? NaN : Number(storedValue);
    return Number.isFinite(stored) && stored >= 0 ? Math.floor(stored) : wallClockFallback;
  });
  const elapsedSecondsRef = useRef(initialElapsedSeconds);
  const [submissionComplete, setSubmissionComplete] = useState(false);
  const [showTimeWarning, setShowTimeWarning] = useState(false);
  const [showForcedSubmission, setShowForcedSubmission] = useState(false);
  const [showSubmissionExtension, setShowSubmissionExtension] = useState(false);
  const [hasExtendedTime, setHasExtendedTime] = useState(false);
  const [isSubmissionConfirmationOpen, setIsSubmissionConfirmationOpen] = useState(false);
  const [minimumSubmissionTimeReached, setMinimumSubmissionTimeReached] = useState(
    initialElapsedSeconds >= 10 * 60
  );
  const transcriptRef = useRef<WebRTCTranscriptRef>(null);

  // Paper 2 (2026-09) test mode debug panel state - see PAPER2_MANIPULATION_PLAN.md section 11.
  const isTestUser = userId.toLowerCase().startsWith('test');
  const [debugTranscript, setDebugTranscript] = useState<string[]>([]);
  const [debugPartialTranscript, setDebugPartialTranscript] = useState<string | null>(null);
  const [debugStages, setDebugStages] = useState<AgentStageEvent[]>([]);
  const [transcriptChunks, setTranscriptChunks] = useState<string[]>([]);
  const [speechActivityAt, setSpeechActivityAt] = useState(0);
  const warningShownRef = useRef(false);
  const forcedSubmissionShownRef = useRef(false);
  const extensionPromptShownRef = useRef(false);
  const writingReminderShownRef = useRef(false);

  // Paper 2: Low-TF two-phase lock (collect -> synthesize). Non-Low-TF and control
  // sessions never get a manipulation_state row with tf_level === 'low', so isLowTF
  // stays false and the writing area behaves exactly as before.
  const [isLowTF, setIsLowTF] = useState(false);
  const [isHighTF, setIsHighTF] = useState(false);
  const [manipulationPhase, setManipulationPhase] = useState<'collect' | 'synthesize' | 'na' | null>(null);
  const [canAdvancePhase, setCanAdvancePhase] = useState(false);
  const [advancingPhase, setAdvancingPhase] = useState(false);
  const [showAdvancePhaseConfirm, setShowAdvancePhaseConfirm] = useState(false);
  const [showPhaseReminder, setShowPhaseReminder] = useState(false);
  const phaseReminderShownRef = useRef(false);
  const [showPhaseLimit, setShowPhaseLimit] = useState(false);
  const phaseLimitShownRef = useRef(false);
  const [showWritingReminder, setShowWritingReminder] = useState(false);
  const [writingPhaseStartElapsed, setWritingPhaseStartElapsed] = useState<number | null>(null);
  const [writingMinimumTimeReached, setWritingMinimumTimeReached] = useState(false);

  const STANDARD_TIME_WARNING_SECONDS = 20 * 60;
  const STANDARD_TIME_LIMIT_SECONDS = 25 * 60;
  const MIN_COLLECT_PHASE_SECONDS = 5 * 60; // 5 minutes - matches backend MIN_COLLECT_PHASE_MS
  const COLLECT_PHASE_REMINDER_SECONDS = 15 * 60; // 15-minute soft reminder if still in "collect"
  const COLLECT_PHASE_LIMIT_SECONDS = 19 * 60;
  const WRITING_REMINDER_SECONDS = 20 * 60;
  const SCHEDULED_END_SECONDS = 25 * 60;
  const EXTENDED_TIME_LIMIT_SECONDS = 27 * 60;
  const MIN_WRITING_PHASE_SECONDS = 4 * 60;

  // Paper 2: fetch this session's manipulation condition/phase once on mount.
  useEffect(() => {
    let cancelled = false;
    const fetchManipulationState = async () => {
      try {
        const response = await fetch(`/api/session/${sessionId}/manipulation-state`);
        if (!response.ok) return;
        const data = await response.json();
        if (cancelled) return;
        if (data.enabled && !data.isControl && data.tfLevel === 'low') {
          setIsLowTF(true);
          const phase = data.phase ?? 'collect';
          setManipulationPhase(phase);
          if (phase === 'collect' && elapsedSecondsRef.current >= MIN_COLLECT_PHASE_SECONDS) {
            setCanAdvancePhase(true);
          }
          if (phase === 'synthesize') {
            const storedPhaseStartValue = typeof window === 'undefined'
              ? null
              : window.localStorage.getItem(writingPhaseStorageKey);
            const storedPhaseStart = storedPhaseStartValue === null ? NaN : Number(storedPhaseStartValue);
            const phaseStart = Number.isFinite(storedPhaseStart) && storedPhaseStart >= 0
              ? Math.floor(storedPhaseStart)
              : data.phaseAdvancedAt
                ? Math.max(0, Math.floor((new Date(data.phaseAdvancedAt).getTime() - sessionStartTime) / 1000))
                : elapsedSecondsRef.current;
            setWritingPhaseStartElapsed(phaseStart);
            if (elapsedSecondsRef.current - phaseStart >= MIN_WRITING_PHASE_SECONDS) {
              setWritingMinimumTimeReached(true);
            }
          }
        } else if (data.enabled && !data.isControl && data.tfLevel === 'high') {
          setIsHighTF(true);
        }
      } catch (error) {
        console.error('[Actual] Error fetching manipulation state:', error);
      }
    };
    if (sessionId) {
      fetchManipulationState();
    }
    return () => { cancelled = true; };
  }, [sessionId, sessionStartTime, MIN_COLLECT_PHASE_SECONDS, MIN_WRITING_PHASE_SECONDS, writingPhaseStorageKey]);

  // Auto-start recording when page loads
  useEffect(() => {
    if (transcriptRef.current) {
      // Longer delay to ensure practice session is fully cleaned up
      setTimeout(() => {
        console.log('[Actual] Auto-starting recording for main task...');
        transcriptRef.current?.startRecording();
      }, 500);
    }
  }, []);

  // Cleanup on unmount - ensure session is terminated
  useEffect(() => {
    // Capture ref value in the effect scope
    const currentTranscriptRef = transcriptRef.current;
    return () => {
      console.log('[Actual] Component unmounting - stopping recording');
      if (currentTranscriptRef) {
        currentTranscriptRef.stopRecording();
      }
    };
  }, []);

  const handleTimerTick = React.useCallback((seconds: number) => {
    elapsedSecondsRef.current = seconds;
    try {
      window.localStorage.setItem(elapsedStorageKey, String(seconds));
    } catch {
      // A blocked storage API should not prevent the participant's timer from running.
    }

    // Re-render the writing section once at the 10-minute threshold so its submit
    // button becomes available even when the participant is not currently typing.
    if (seconds >= 10 * 60 && !minimumSubmissionTimeReached) {
      setMinimumSubmissionTimeReached(true);
    }

    if (!isLowTF) {
      // One-phase sessions all receive a five-minute warning. High-TF treatment
      // groups can choose a final two-minute wrap-up at the scheduled end.
      if (seconds >= STANDARD_TIME_WARNING_SECONDS && !warningShownRef.current && !forcedSubmissionShownRef.current) {
        warningShownRef.current = true;
        setShowTimeWarning(true);
      }
      if (isHighTF && seconds >= SCHEDULED_END_SECONDS && !extensionPromptShownRef.current) {
        extensionPromptShownRef.current = true;
        setShowSubmissionExtension(true);
      }
      if (isHighTF && hasExtendedTime && seconds >= EXTENDED_TIME_LIMIT_SECONDS && !forcedSubmissionShownRef.current) {
        forcedSubmissionShownRef.current = true;
        setShowForcedSubmission(true);
      }
      if (!isHighTF && seconds >= STANDARD_TIME_LIMIT_SECONDS && !forcedSubmissionShownRef.current) {
        forcedSubmissionShownRef.current = true;
        setShowForcedSubmission(true);
      }
      return;
    }

    if (manipulationPhase === 'collect') {
      if (seconds >= MIN_COLLECT_PHASE_SECONDS && !canAdvancePhase) {
        setCanAdvancePhase(true);
      }
      if (seconds >= COLLECT_PHASE_REMINDER_SECONDS && !phaseReminderShownRef.current) {
        phaseReminderShownRef.current = true;
        setShowPhaseReminder(true);
      }
      if (seconds >= COLLECT_PHASE_LIMIT_SECONDS && !phaseLimitShownRef.current) {
        phaseLimitShownRef.current = true;
        setShowPhaseLimit(true);
      }
      return;
    }

    if (manipulationPhase === 'synthesize') {
      if (writingPhaseStartElapsed !== null && seconds - writingPhaseStartElapsed >= MIN_WRITING_PHASE_SECONDS && !writingMinimumTimeReached) {
        setWritingMinimumTimeReached(true);
      }
      if (seconds >= WRITING_REMINDER_SECONDS && !writingReminderShownRef.current) {
        writingReminderShownRef.current = true;
        setShowWritingReminder(true);
      }
      if (seconds >= SCHEDULED_END_SECONDS && !extensionPromptShownRef.current) {
        extensionPromptShownRef.current = true;
        setShowSubmissionExtension(true);
      }
      if (hasExtendedTime && seconds >= EXTENDED_TIME_LIMIT_SECONDS && !forcedSubmissionShownRef.current) {
        forcedSubmissionShownRef.current = true;
        setShowForcedSubmission(true);
      }
    }
  }, [STANDARD_TIME_WARNING_SECONDS, STANDARD_TIME_LIMIT_SECONDS, MIN_COLLECT_PHASE_SECONDS, COLLECT_PHASE_REMINDER_SECONDS, COLLECT_PHASE_LIMIT_SECONDS, WRITING_REMINDER_SECONDS, SCHEDULED_END_SECONDS, EXTENDED_TIME_LIMIT_SECONDS, MIN_WRITING_PHASE_SECONDS, isLowTF, isHighTF, manipulationPhase, canAdvancePhase, minimumSubmissionTimeReached, writingPhaseStartElapsed, writingMinimumTimeReached, hasExtendedTime, elapsedStorageKey]);

  const handleRequestAdvancePhase = () => {
    logger.logEvent({
      eventType: 'ui',
      action: 'button_click',
      target: { element: 'next-phase-button', section: 'writing' },
      metadata: {
        actionType: 'phase_transition_next_clicked',
        fromPhase: manipulationPhase,
        toPhase: 'synthesize',
        canAdvancePhase,
      },
    });
    setShowAdvancePhaseConfirm(true);
  };

  const handleAdvancePhase = async (source: 'manual' | 'phase_limit') => {
    if (advancingPhase) return;
    // Flush before advancing: the phase-boundary timeline must include both the Next
    // click and the participant's explicit confirmation.
    logger.logEvent({
      eventType: 'ui',
      action: 'phase_transition_confirmed',
      target: { element: 'confirm-next-phase-button', section: 'writing' },
      metadata: {
        actionType: 'phase_transition_confirmed',
        source,
        fromPhase: manipulationPhase,
        toPhase: 'synthesize',
      },
    });
    await logger.sendBatch();
    setAdvancingPhase(true);
    try {
      const response = await fetch(`/api/session/${sessionId}/advance-phase`, { method: 'POST' });
      const data = await response.json();
      if (response.ok && data.advanced) {
        setManipulationPhase('synthesize');
        setShowPhaseReminder(false);
        setShowPhaseLimit(false);
        setShowAdvancePhaseConfirm(false);
        const phaseStartElapsed = elapsedSecondsRef.current;
        setWritingPhaseStartElapsed(phaseStartElapsed);
        try {
          window.localStorage.setItem(writingPhaseStorageKey, String(phaseStartElapsed));
        } catch {
          // The current page state still keeps the phase timing correct if storage is unavailable.
        }
        setWritingMinimumTimeReached(false);
        logger.logEvent({
          eventType: 'ui',
          action: 'phase_transition_client_acknowledged',
          target: { element: 'confirm-next-phase-button', section: 'writing' },
          metadata: {
            actionType: 'phase_transition_client_acknowledged',
            fromPhase: 'collect',
            toPhase: data.phase ?? 'synthesize',
            phaseAdvancedAt: data.phaseAdvancedAt ?? null,
          },
        });
        void logger.sendBatch();
      } else if (data.remainingMs) {
        console.warn('[Actual] Cannot advance phase yet:', data.message);
      }
    } catch (error) {
      console.error('[Actual] Error advancing phase:', error);
    } finally {
      setAdvancingPhase(false);
    }
  };

  const handleTimeWarningContinue = () => {
    setShowTimeWarning(false);
  };

  const handleContinueExploring = () => {
    setShowPhaseReminder(false);
  };

  const handleContinueWriting = () => {
    setShowWritingReminder(false);
  };

  const handleRequestExtraTime = () => {
    setShowSubmissionExtension(false);
    setHasExtendedTime(true);
  };

  const isTimerPaused =
    showTimeWarning ||
    showForcedSubmission ||
    isSubmissionConfirmationOpen ||
    showSubmissionExtension ||
    (isLowTF && (
      showAdvancePhaseConfirm ||
      showPhaseReminder ||
      showPhaseLimit ||
      showWritingReminder ||
      showSubmissionExtension
    ));

  const handleSubmissionComplete = async () => {
    // Stop recording when submission is complete
    if (transcriptRef.current) {
      transcriptRef.current.stopRecording();
    }

    // Try to send any remaining logs (but don't block if it fails)
    try {
      await logger.sendBatch();
    } catch (error) {
      console.warn('Failed to send final log batch, but submission will continue:', error);
    }

    // Show confirmation page
    setSubmissionComplete(true);
  };

  if (submissionComplete) {
    return <SubmissionConfirmation />;
  }

  return (
    <>
      <DebugPanel isTestUser={isTestUser} isPracticeSession={false} transcript={debugTranscript} partialTranscript={debugPartialTranscript} stages={debugStages} />

      {/* Timer - visible count up for the participant's time awareness. */}
      <Timer
        mode="countup"
        initialSeconds={initialElapsedSeconds}
        visible={true}
        onTick={handleTimerTick}
        paused={isTimerPaused}
      />

      {/* One-phase groups receive a reminder at 20 total minutes. */}
      {showTimeWarning && (
        <TimeWarningPopup onContinue={handleTimeWarningContinue} />
      )}

      {/* Paper 2 Low-TF: Phase 1 status. The persistent Next button lives below the locked writing message. */}
      {isLowTF && manipulationPhase === 'collect' && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '1rem',
          padding: '0.625rem 1rem',
          margin: '0.5rem 1rem 0',
          backgroundColor: '#fefce8',
          border: '1px solid #fde68a',
          borderRadius: '0.5rem',
          fontSize: '0.875rem',
          color: '#78350f'
        }}>
          <span>
            {canAdvancePhase
              ? "You can now continue to the writing phase using the Next button in the writing area."
              : 'Keep exploring ideas with the chatbot for now. The Next button in the writing area will be enabled 5 minutes after the main task begins.'}
          </span>
        </div>
      )}

      {/* Low-TF: changing phase is irreversible because it removes participant-initiated prompting. */}
      {showAdvancePhaseConfirm && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '1rem'
        }} role="dialog" aria-modal="true" aria-labelledby="advance-phase-title">
          <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', maxWidth: '30rem', width: '100%' }}>
            <h2 id="advance-phase-title" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>
              Move to the writing phase?
            </h2>
            <p style={{ color: '#4b5563', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              In the next phase, you can write your final design proposal, but you will no longer be able to send prompts or request new AI responses. AI guidance may still appear in the chat.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' }}>
              <button onClick={() => setShowAdvancePhaseConfirm(false)} style={{ padding: '0.5rem 0.875rem', border: '1px solid #d1d5db', borderRadius: '0.375rem', backgroundColor: 'white', color: '#374151', cursor: 'pointer' }}>
                Stay in exploration
              </button>
              <button onClick={() => handleAdvancePhase('manual')} style={{ padding: '0.5rem 0.875rem', border: 'none', borderRadius: '0.375rem', backgroundColor: '#f59e0b', color: 'white', cursor: 'pointer' }}>
                Continue to writing
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Low-TF: at 15 minutes, pause before the Phase 1 limit and let the participant continue exploring. */}
      {showPhaseReminder && manipulationPhase === 'collect' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '1rem'
        }} role="dialog" aria-modal="true" aria-labelledby="phase-reminder-title">
          <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', maxWidth: '30rem', width: '100%' }}>
            <h2 id="phase-reminder-title" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>Time Check</h2>
            <p style={{ color: '#4b5563', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              You have been in the exploration phase for 15 minutes. You have 4 minutes remaining before you move to the writing phase.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={handleContinueExploring} style={{ padding: '0.5rem 0.875rem', border: 'none', borderRadius: '0.375rem', backgroundColor: '#f59e0b', color: 'white', cursor: 'pointer' }}>
                Continue Exploring
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Low-TF: Phase 1 has a hard 19-minute limit. */}
      {showPhaseLimit && manipulationPhase === 'collect' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '1rem'
        }} role="dialog" aria-modal="true" aria-labelledby="phase-limit-title">
          <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', maxWidth: '30rem', width: '100%' }}>
            <h2 id="phase-limit-title" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>Exploration Phase Complete</h2>
            <p style={{ color: '#4b5563', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              You have reached the 19-minute limit for the exploration phase. Your exploration work has been saved. Please continue to the writing phase now.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={() => handleAdvancePhase('phase_limit')} disabled={advancingPhase} style={{ padding: '0.5rem 0.875rem', border: 'none', borderRadius: '0.375rem', backgroundColor: advancingPhase ? '#fcd34d' : '#f59e0b', color: 'white', cursor: advancingPhase ? 'wait' : 'pointer' }}>
                {advancingPhase ? 'Moving on...' : 'Continue to Writing'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Low-TF: writing reminder at 20 total active minutes. */}
      {showWritingReminder && manipulationPhase === 'synthesize' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '1rem'
        }} role="dialog" aria-modal="true" aria-labelledby="writing-reminder-title">
          <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', maxWidth: '30rem', width: '100%' }}>
            <h2 id="writing-reminder-title" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>Five Minutes Remaining</h2>
            <p style={{ color: '#4b5563', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              You have 5 minutes remaining to complete your written response. Please be careful with the time management.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={handleContinueWriting} style={{ padding: '0.5rem 0.875rem', border: 'none', borderRadius: '0.375rem', backgroundColor: '#f59e0b', color: 'white', cursor: 'pointer' }}>
                Continue Writing
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="main-grid bg-token-bg-primary text-token-text-primary">
        {/* LLM Chat Interface - Left Half */}
        <div className="section-chat border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
          <ChatInterface
            sessionId={sessionId}
            sessionStartTime={sessionStartTime}
            logger={logger}
            onAgentStage={(stage) => setDebugStages(prev => [...prev, stage])}
            transcriptChunks={transcriptChunks}
            speechActivityAt={speechActivityAt}
            promptingEnabled={!(isLowTF && manipulationPhase === 'synthesize')}
          />
        </div>

        {/* Right Half - Transcript and Writing */}
        <div className="section-right">
          {/* Voice Transcript Section - Top Right */}
          <div className="section-transcript border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
            <WebRTCTranscript
              ref={transcriptRef}
              isPracticeMode={false}
              sessionId={sessionId}
              onTranscriptUpdate={(chunks) => { setDebugTranscript(chunks); setTranscriptChunks(chunks); }}
              onTranscriptPartialUpdate={setDebugPartialTranscript}
              onSpeechActivity={setSpeechActivityAt}
            />
          </div>

          {/* Final Writing/Submission Section - Bottom Right */}
          <div className="section-writing border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
            <WritingSection
              sessionId={sessionId}
              transcriptRef={transcriptRef}
              sessionStartTime={sessionStartTime}
              logger={logger}
              isPracticeMode={false}
              elapsedTimeRef={elapsedSecondsRef}
              minimumTimeMet={minimumSubmissionTimeReached}
              writingMinimumTimeMet={!isLowTF || (manipulationPhase === 'synthesize' && writingMinimumTimeReached)}
              onSubmissionComplete={handleSubmissionComplete}
              showForcedSubmission={showForcedSubmission}
              showSubmissionExtension={showSubmissionExtension}
              onRequestExtraTime={handleRequestExtraTime}
              onTimerPauseChange={setIsSubmissionConfirmationOpen}
              locked={isLowTF && manipulationPhase === 'collect'}
              canAdvanceToWriting={isLowTF && manipulationPhase === 'collect' && canAdvancePhase}
              onAdvanceToWriting={isLowTF && manipulationPhase === 'collect' ? handleRequestAdvancePhase : undefined}
              advancingToWriting={advancingPhase}
            />
          </div>
        </div>
      </div>
    </>
  );
};

export default ResearchPageActual;
