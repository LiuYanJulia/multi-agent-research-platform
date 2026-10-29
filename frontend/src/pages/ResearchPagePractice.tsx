import React, { useState, useRef } from 'react';
import ChatInterface from '../components/ChatInterface';
import WebRTCTranscript, { WebRTCTranscriptRef } from '../components/WebRTCTranscript';
import GuidancePanel, { DisplayedGuidance } from '../components/GuidancePanel';
import WritingSection from '../components/WritingSection';
import Timer from '../components/Timer';
import DebugPanel, { AgentStageEvent } from '../components/DebugPanel';
import { useInteractionLogger } from '../hooks/useInteractionLogger';
import '../App.css';

interface ResearchPagePracticeProps {
  sessionId: string;
  sessionStartTime: number;
  userId: string;
  groupId: string;
  onComplete: () => void;
}


const PRACTICE_DURATION_SECONDS = 120; // 2 minutes
const TWO_PHASE_PRACTICE_PHASE_SECONDS = 90; // 1.5 minutes per phase (3 minutes total)

const ResearchPagePractice: React.FC<ResearchPagePracticeProps> = ({
  sessionId,
  sessionStartTime,
  userId,
  groupId,
  onComplete
}) => {
  // Initialize logger only when this page is mounted (for practice session)
  const logger = useInteractionLogger({
    sessionId: sessionId,
    sessionStartTime: sessionStartTime,
    batchSize: 50,
    batchInterval: 5000,
  });
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const isTwoPhasePractice = ['4', '5', 'lowtf_hightm', 'lowtf_lowtm'].includes(groupId.trim().toLowerCase());
  const [practicePhase, setPracticePhase] = useState<'exploration' | 'writing'>('exploration');
  const [showPhaseTransitionModal, setShowPhaseTransitionModal] = useState(false);
  const [advancingPracticePhase, setAdvancingPracticePhase] = useState(false);
  const [practicePhaseError, setPracticePhaseError] = useState('');
  const transcriptRef = useRef<WebRTCTranscriptRef>(null);

  // Paper 2 (2026-09) test mode debug panel state - see PAPER2_MANIPULATION_PLAN.md section 11.
  const isTestUser = userId.toLowerCase().startsWith('test');
  const [debugTranscript, setDebugTranscript] = useState<string[]>([]);
  const [debugPartialTranscript, setDebugPartialTranscript] = useState<string | null>(null);
  const [debugStages, setDebugStages] = useState<AgentStageEvent[]>([]);
  const [transcriptChunks, setTranscriptChunks] = useState<string[]>([]);
  const [speechActivityAt, setSpeechActivityAt] = useState(0);
  const [displayedGuidance, setDisplayedGuidance] = useState<DisplayedGuidance[]>([]);
  const [newlyDeliveredGuidanceId, setNewlyDeliveredGuidanceId] = useState<string | null>(null);
  const guidanceFlashTimerRef = useRef<number | null>(null);

  const handleGuidanceChange = React.useCallback((guidance: DisplayedGuidance[], newlyDeliveredId?: string) => {
    setDisplayedGuidance(guidance.slice(-3));
    if (!newlyDeliveredId) return;
    setNewlyDeliveredGuidanceId(newlyDeliveredId);
    if (guidanceFlashTimerRef.current !== null) window.clearTimeout(guidanceFlashTimerRef.current);
    guidanceFlashTimerRef.current = window.setTimeout(() => {
      setNewlyDeliveredGuidanceId(null);
      guidanceFlashTimerRef.current = null;
    }, 2_600);
  }, []);

  React.useEffect(() => () => {
    if (guidanceFlashTimerRef.current !== null) window.clearTimeout(guidanceFlashTimerRef.current);
  }, []);

  // Resume-on-refresh (2026-09): if the page reloads mid-practice, sessionStartTime is restored
  // from localStorage (see App.tsx) rather than reset, so the countdown continues from the real
  // remaining time instead of restarting a fresh 2 minutes.
  const elapsedOnMountSeconds = sessionStartTime ? Math.floor((Date.now() - sessionStartTime) / 1000) : 0;
  const remainingOnMountSeconds = Math.max(0, PRACTICE_DURATION_SECONDS - elapsedOnMountSeconds);
  // The two-phase timer starts only after the participant leaves the practice welcome page,
  // so reading the instructions never uses either 90-second phase.
  const currentPracticePhaseSeconds = isTwoPhasePractice
    ? TWO_PHASE_PRACTICE_PHASE_SECONDS
    : remainingOnMountSeconds;

  // Auto-start recording when page loads
  React.useEffect(() => {
    if (transcriptRef.current) {
      setTimeout(() => {
        console.log('Auto-starting recording for practice session...');
        transcriptRef.current?.startRecording();
      }, 1000);
    }
  }, []);

  // Resume-on-refresh: if the real remaining time was already 0 when this page (re)mounted
  // (e.g. the participant refreshed after the 2 minutes had already elapsed), show the complete
  // modal immediately instead of waiting for a countdown that would never reach 0 on its own.
  React.useEffect(() => {
    if (!isTwoPhasePractice && remainingOnMountSeconds <= 0) {
      handleTimerExpire();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTimerExpire = () => {
    if (isTwoPhasePractice && practicePhase === 'exploration') {
      // The countdown has reached zero and stopped. Keep it paused while the participant
      // reads the transition prompt; the second 90-second timer begins only after Next.
      setShowPhaseTransitionModal(true);
      return;
    }

    // Stop recording when practice time is up
    if (transcriptRef.current) {
      console.log('[Practice] Stopping recording due to timer expiration');
      transcriptRef.current.stopRecording();
    }

    // Show modal
    setShowCompleteModal(true);
  };

  const handleAdvancePracticePhase = async () => {
    if (advancingPracticePhase) return;
    setAdvancingPracticePhase(true);
    setPracticePhaseError('');
    try {
      // The practice modal's Next button is also the participant's irreversible
      // confirmation. Flush it before the server builds the phase boundary.
      logger.logEvent({
        eventType: 'ui',
        action: 'button_click',
        target: { element: 'practice-next-phase-button', section: 'writing' },
        metadata: {
          actionType: 'phase_transition_next_clicked',
          fromPhase: 'exploration',
          toPhase: 'writing',
          isPractice: true,
        },
      });
      logger.logEvent({
        eventType: 'ui',
        action: 'phase_transition_confirmed',
        target: { element: 'practice-next-phase-button', section: 'writing' },
        metadata: {
          actionType: 'phase_transition_confirmed',
          fromPhase: 'exploration',
          toPhase: 'writing',
          isPractice: true,
        },
      });
      await logger.sendBatch();
      // Keep the server-side Manipulation Controller in sync with the visible practice
      // phase, so its Phase 2 target changes from D to C and its streak restarts at zero.
      const response = await fetch(`/api/session/${sessionId}/advance-phase`, { method: 'POST' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.advanced) {
        throw new Error(data.message || 'Unable to move to the writing phase.');
      }
      setShowPhaseTransitionModal(false);
      setPracticePhase('writing');
      logger.logEvent({
        eventType: 'ui',
        action: 'phase_transition_client_acknowledged',
        target: { element: 'practice-next-phase-button', section: 'writing' },
        metadata: {
          actionType: 'phase_transition_client_acknowledged',
          fromPhase: 'exploration',
          toPhase: data.phase ?? 'synthesize',
          phaseAdvancedAt: data.phaseAdvancedAt ?? null,
          isPractice: true,
        },
      });
      void logger.sendBatch();
    } catch (error) {
      console.error('[Practice] Error advancing phase:', error);
      setPracticePhaseError(error instanceof Error ? error.message : 'Unable to move to the writing phase. Please try again.');
    } finally {
      setAdvancingPracticePhase(false);
    }
  };

  const handleContinue = () => {
    // Validate password (case-sensitive)
    if (password !== 'Continue') {
      setPasswordError('Incorrect password. Please try again.');
      return;
    }

    // CRITICAL: Ensure recording is fully stopped before navigating
    if (transcriptRef.current) {
      console.log('[Practice] Ensuring recording stopped before navigation');
      transcriptRef.current.stopRecording();
    }

    setShowCompleteModal(false);

    // Give a brief delay to ensure cleanup completes before unmounting
    setTimeout(() => {
      onComplete();
    }, 100);
  };

  // Cleanup on unmount - ensure session is terminated
  React.useEffect(() => {
    // Capture ref value in the effect scope
    const currentTranscriptRef = transcriptRef.current;
    return () => {
      console.log('[Practice] Component unmounting - stopping recording');
      if (currentTranscriptRef) {
        currentTranscriptRef.stopRecording();
      }
    };
  }, []);

  return (
    <>
      <DebugPanel isTestUser={isTestUser} isPracticeSession={true} transcript={debugTranscript} partialTranscript={debugPartialTranscript} stages={debugStages} />

      {/* Timer - standard practice is 2 minutes; groups 4/5 use two 90-second phases. */}
      <Timer
        key={isTwoPhasePractice ? practicePhase : 'standard-practice'}
        mode="countdown"
        initialSeconds={currentPracticePhaseSeconds}
        visible={true}
        onExpire={handleTimerExpire}
        paused={showPhaseTransitionModal}
      />

      {isTwoPhasePractice && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem',
          padding: '0.625rem 1rem', margin: '0.5rem 1rem 0', borderRadius: '0.5rem',
          backgroundColor: practicePhase === 'exploration' ? '#fefce8' : '#eff6ff',
          border: `1px solid ${practicePhase === 'exploration' ? '#fde68a' : '#bfdbfe'}`,
          fontSize: '0.875rem', color: practicePhase === 'exploration' ? '#78350f' : '#1e40af'
        }}>
          {practicePhase === 'exploration'
            ? 'Exploration phase: discuss ideas with the AI. The writing area opens after this 1 minute 30 second phase.'
            : 'Writing phase: write your proposal. Direct prompts to the AI are unavailable, but AI guidance may still appear.'}
        </div>
      )}

      <div className="main-grid bg-token-bg-primary text-token-text-primary">
        {/* LLM Chat Interface - Left Half */}
        <div className="section-chat border border-gray-200 rounded-lg p-4 bg-token-bg-primary" style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '0.75rem 1rem 0', flexShrink: 0 }}>
            <WebRTCTranscript
              ref={transcriptRef}
              isPracticeMode={true}
              compactStatus
              sessionId={sessionId}
              onTranscriptUpdate={(chunks) => { setDebugTranscript(chunks); setTranscriptChunks(chunks); }}
              onTranscriptPartialUpdate={setDebugPartialTranscript}
              onSpeechActivity={setSpeechActivityAt}
            />
          </div>
          <div style={{ flex: '1 1 0', minHeight: 0 }}>
            <ChatInterface
              sessionId={sessionId}
              sessionStartTime={sessionStartTime}
              logger={logger}
              onAgentStage={(stage) => setDebugStages(prev => [...prev, stage])}
              transcriptChunks={transcriptChunks}
              speechActivityAt={speechActivityAt}
              promptingEnabled={!isTwoPhasePractice || practicePhase === 'exploration'}
              onGuidanceChange={handleGuidanceChange}
            />
          </div>
        </div>

        {/* Right Half - Proactive guidance above final writing */}
        <div className="section-right section-right-with-guidance">
          <div className="section-guidance p-4">
            <GuidancePanel guidance={displayedGuidance} newlyDeliveredId={newlyDeliveredGuidanceId} />
          </div>

          {/* Final Writing/Submission Section - Bottom Right */}
          <div className="section-writing border border-gray-200 rounded-lg p-4 bg-token-bg-primary">
            <WritingSection
              sessionId={sessionId}
              transcriptRef={transcriptRef}
              sessionStartTime={sessionStartTime}
              logger={logger}
              isPracticeMode={true}
              taskDescription="Toy"
              locked={isTwoPhasePractice && practicePhase === 'exploration'}
            />
          </div>
        </div>
      </div>

      {/* Groups 4/5: the first timer has stopped at 1:30; Next starts the second timer. */}
      {showPhaseTransitionModal && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0, 0, 0, 0.5)', padding: '1rem'
        }} role="dialog" aria-modal="true" aria-labelledby="practice-phase-title">
          <div style={{ backgroundColor: 'white', borderRadius: '0.5rem', padding: '1.5rem', maxWidth: '30rem', width: '100%' }}>
            <h2 id="practice-phase-title" style={{ fontSize: '1.125rem', fontWeight: 600, marginBottom: '0.75rem' }}>
              Exploration phase complete
            </h2>
            <p style={{ color: '#4b5563', fontSize: '0.875rem', lineHeight: 1.5, marginBottom: '1.25rem' }}>
              The timer is paused. Select Next to enter the 1 minute 30 second writing phase. The writing area will open, but you will no longer be able to send prompts or request new AI responses. AI guidance may still appear in the chat.
            </p>
            {practicePhaseError && (
              <p style={{ color: '#b91c1c', fontSize: '0.8125rem', marginTop: '-0.75rem', marginBottom: '1rem' }}>
                {practicePhaseError}
              </p>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button onClick={handleAdvancePracticePhase} disabled={advancingPracticePhase} style={{ padding: '0.5rem 0.875rem', border: 'none', borderRadius: '0.375rem', backgroundColor: advancingPracticePhase ? '#fcd34d' : '#f59e0b', color: 'white', cursor: advancingPracticePhase ? 'wait' : 'pointer' }}>
                {advancingPracticePhase ? 'Moving on...' : 'Next: Move to writing →'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Practice Complete Modal */}
      {showCompleteModal && (
        <div style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999
        }}>
          <div style={{
            backgroundColor: 'white',
            borderRadius: '0.5rem',
            padding: '2rem',
            maxWidth: '28rem',
            width: '100%',
            margin: '0 1rem'
          }}>
            <div style={{
              textAlign: 'center',
              marginBottom: '1.5rem'
            }}>
              <svg
                style={{
                  margin: '0 auto 1rem',
                  width: '3rem',
                  height: '3rem',
                  color: '#10b981'
                }}
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <h3 style={{
                fontSize: '1.25rem',
                fontWeight: '600',
                marginBottom: '0.5rem'
              }}>
                Practice Task Complete
              </h3>
              <p style={{
                fontSize: '0.875rem',
                color: '#6b7280',
                marginBottom: '1rem'
              }}>
                Time's up, practice finished. Research team will come and check again. Please stay at this page. You need a password to continue with the main task.
              </p>
            </div>

            {/* Password Input */}
            <div style={{ marginBottom: '1rem' }}>
              <input
                type="text"
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(''); // Clear error when typing
                }}
                placeholder="Enter password"
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  border: passwordError ? '2px solid #ef4444' : '1px solid #d1d5db',
                  borderRadius: '0.5rem',
                  fontSize: '1rem',
                  outline: 'none',
                  transition: 'border-color 0.2s'
                }}
                onFocus={(e) => {
                  if (!passwordError) {
                    e.currentTarget.style.borderColor = '#10b981';
                  }
                }}
                onBlur={(e) => {
                  if (!passwordError) {
                    e.currentTarget.style.borderColor = '#d1d5db';
                  }
                }}
              />
              {passwordError && (
                <p style={{
                  marginTop: '0.5rem',
                  fontSize: '0.875rem',
                  color: '#ef4444'
                }}>
                  {passwordError}
                </p>
              )}
            </div>

            <button
              onClick={handleContinue}
              style={{
                width: '100%',
                padding: '0.75rem 1rem',
                backgroundColor: '#10b981',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                fontSize: '1rem',
                fontWeight: '600',
                cursor: 'pointer',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#059669'}
              onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#10b981'}
            >
              Continue to Main Task
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default ResearchPagePractice;
