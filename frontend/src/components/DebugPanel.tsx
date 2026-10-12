import React, { useState } from 'react';

// Paper 2 (2026-09) test mode: a small debug panel for testers, gated on userId starting with
// "test" (see backend/src/utils/sessionUtils.ts isTestSession, which mirrors this check
// server-side). Shows the live voice transcript and a real-time timeline of what the
// multi-agent manipulation pipeline is doing each turn (evaluation agent, manipulation
// controller, main response agent) - see PAPER2_MANIPULATION_PLAN.md section 11.
//
// This never affects the regular participant interface: isTestUser is false for every real
// participant, and this component renders nothing in that case.

export interface AgentStageEvent {
  agent: 'evaluation_agent' | 'decision_agent' | 'manipulation_controller' | 'main_response_agent';
  status: 'started' | 'completed' | 'error';
  detail?: string;
  evaluationInput?: Array<{
    eventId: number;
    timestampStart: number;
    timestampEnd: number;
    eventType: 'user_action' | 'user_speech' | 'user_message' | 'ai_response';
    actionDescription: string;
    speech: string;
    userMessage: string;
    aiResponse: string;
  }>;
  evaluationMoves?: Array<{
    moveType: number;
    orientation?: 'D' | 'C';
    description: string;
    eventIdStart?: number;
    eventIdEnd?: number;
  }>;
  evaluationRaw?: unknown;
  moves?: Array<{
    moveId: number;
    contentMoveNumber: number;
    moveType: number;
    moveTypeName: string;
    orientation?: 'D' | 'C';
    description: string;
    eventIdStart?: number;
    eventIdEnd?: number;
  }>;
  moveCounts?: { d: number; c: number };
  streak?: { orientation: 'D' | 'C' | null; count: number; suppressionRemaining?: number };
  timestamp: number;
}

interface DebugPanelProps {
  isTestUser: boolean;
  isPracticeSession: boolean;
  // Paper 2 (2026-09): one completed transcription chunk per entry, in completion order - each
  // is rendered on its own line so testers can see the actual segmentation boundaries the
  // transcription API is producing, instead of one run-on paragraph.
  transcript: string[];
  partialTranscript: string | null;
  stages: AgentStageEvent[];
}

const AGENT_LABELS: Record<AgentStageEvent['agent'], string> = {
  evaluation_agent: 'Evaluation Agent',
  decision_agent: 'Decision Agent',
  manipulation_controller: 'Manipulation Controller',
  main_response_agent: 'Main Response Agent',
};

const PANEL_WIDTH = 340;

const DebugPanel: React.FC<DebugPanelProps> = ({ isTestUser, isPracticeSession, transcript, partialTranscript, stages }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [expandedEvaluationStage, setExpandedEvaluationStage] = useState<number | null>(null);
  const latestMoveCounts = [...stages].reverse().find((stage) => stage.moveCounts)?.moveCounts;
  const latestStreak = [...stages].reverse().find((stage) => stage.streak)?.streak;

  if (!isTestUser) return null;

  return (
    <>
      <button
        onClick={() => setIsOpen((o) => !o)}
        style={{
          position: 'fixed',
          top: '1rem',
          right: isOpen ? `${PANEL_WIDTH + 12}px` : '1rem',
          zIndex: 1100,
          padding: '0.5rem 0.75rem',
          backgroundColor: '#1f2937',
          color: 'white',
          border: 'none',
          borderRadius: '0.375rem',
          fontSize: '0.75rem',
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'right 0.2s ease',
          boxShadow: '0 2px 6px rgba(0,0,0,0.25)',
        }}
        title="Test mode debug panel"
      >
        🐛 Debug{isOpen ? ' ✕' : ''}
      </button>

      <div
        style={{
          position: 'fixed',
          top: 0,
          right: isOpen ? 0 : `-${PANEL_WIDTH}px`,
          width: `${PANEL_WIDTH}px`,
          height: '100vh',
          backgroundColor: '#111827',
          color: '#e5e7eb',
          boxShadow: '-4px 0 16px rgba(0,0,0,0.35)',
          zIndex: 1050,
          transition: 'right 0.2s ease',
          display: 'flex',
          flexDirection: 'column',
          fontSize: '0.75rem',
        }}
      >
        <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid #374151', fontWeight: 700, fontSize: '0.8125rem' }}>
          Test Mode Debug Panel
        </div>

        <div style={{ padding: '0.5rem 1rem', borderBottom: '1px solid #374151', color: isPracticeSession ? '#fbbf24' : '#34d399', fontWeight: 600 }}>
          {isPracticeSession ? 'Practice session: manipulation pipeline enabled' : 'Actual session: manipulation pipeline enabled'}
        </div>

        <div
          style={{
            padding: '0.75rem 1rem',
            borderBottom: '1px solid #374151',
            maxHeight: '35%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#93c5fd', flexShrink: 0 }}>
            Live Transcript {transcript.length > 0 && `(${transcript.length} chunk${transcript.length === 1 ? '' : 's'})`}
          </div>
          <div style={{ overflowY: 'auto', minHeight: 0, color: '#d1d5db', lineHeight: 1.45 }}>
            {transcript.length === 0 && !partialTranscript ? (
              <div style={{ color: '#6b7280' }}>(no speech transcribed yet)</div>
            ) : (
              <>
                {transcript.map((chunk, i) => (
                <div
                  key={i}
                  style={{
                    whiteSpace: 'pre-wrap',
                    marginBottom: '0.4rem',
                    paddingBottom: '0.4rem',
                    borderBottom: i < transcript.length - 1 ? '1px solid #1f2937' : 'none',
                  }}
                >
                  {chunk}
                </div>
                ))}
                {partialTranscript && (
                  <div style={{ color: '#93c5fd', fontStyle: 'italic', whiteSpace: 'pre-wrap' }}>
                    {partialTranscript}
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '0.75rem 1rem', overflowY: 'auto', flex: 1 }}>
          <div style={{ fontWeight: 600, marginBottom: '0.5rem', color: '#93c5fd' }}>
            Agent Execution
          </div>
          {latestMoveCounts && (
            <div style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid #374151', color: '#d1d5db' }}>
              <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>Cumulative Evaluation-Coded Content Moves</div>
              <div style={{ color: '#9ca3af', marginBottom: '0.25rem' }}>D/C derived from the move-type mapping</div>
              <div>
                <span style={{ color: '#60a5fa' }}>D-moves: {latestMoveCounts.d}</span>
                <span style={{ color: '#9ca3af' }}> | </span>
                <span style={{ color: '#fbbf24' }}>C-moves: {latestMoveCounts.c}</span>
              </div>
              {latestStreak && (
                <>
                  <div style={{ color: '#9ca3af', marginTop: '0.25rem' }}>
                    Current streak: {latestStreak.orientation ?? 'none'} x {latestStreak.count}
                  </div>
                  {(latestStreak.suppressionRemaining ?? 0) > 0 && (
                    <div style={{ color: '#fbbf24', marginTop: '0.25rem' }}>
                      Post-Insert moves still ignored: {latestStreak.suppressionRemaining}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {stages.length === 0 && (
            <div style={{ color: '#6b7280' }}>
              (no agent activity yet — send a chat message to start the turn pipeline)
            </div>
          )}
          {stages.map((s, i) => (
            <div
              key={i}
              style={{
                marginBottom: '0.5rem',
                padding: '0.5rem',
                border: s.agent === 'evaluation_agent' && s.status === 'completed' ? '1px solid #334155' : 'none',
                borderRadius: s.agent === 'evaluation_agent' && s.status === 'completed' ? '0.375rem' : 0,
                backgroundColor: s.agent === 'evaluation_agent' && s.status === 'completed' ? '#172033' : 'transparent',
                borderBottom: s.agent === 'evaluation_agent' && s.status === 'completed' ? '1px solid #334155' : '1px solid #1f2937',
              }}
            >
              {s.agent === 'evaluation_agent' && s.status === 'completed' && s.evaluationInput ? (
                <button
                  type="button"
                  onClick={() => setExpandedEvaluationStage((current) => current === i ? null : i)}
                  aria-expanded={expandedEvaluationStage === i}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    width: '100%',
                    padding: 0,
                    border: 'none',
                    background: 'transparent',
                    color: '#34d399',
                    fontWeight: 600,
                    fontSize: 'inherit',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                  title="Show the timeline partition sent to the Evaluation Agent"
                >
                  <span>{AGENT_LABELS[s.agent]} — {s.status}</span>
                  <span style={{ color: '#93c5fd', fontSize: '0.68rem' }}>
                    {expandedEvaluationStage === i ? 'Hide input ▴' : `View input (${s.evaluationInput.length}) ▾`}
                  </span>
                </button>
              ) : (
                <div
                  style={{
                    color: s.status === 'error' ? '#f87171' : s.status === 'started' ? '#fbbf24' : '#34d399',
                    fontWeight: 600,
                  }}
                >
                  {AGENT_LABELS[s.agent]} — {s.status}
                </div>
              )}
              {s.detail && (
                <div style={{ color: '#9ca3af', marginTop: '0.125rem' }}>{s.detail}</div>
              )}
              {s.agent === 'evaluation_agent' && s.status === 'completed' && expandedEvaluationStage === i && s.evaluationInput && (
                <div style={{ marginTop: '0.5rem', paddingTop: '0.5rem', borderTop: '1px solid #334155' }}>
                  <div style={{ color: '#93c5fd', fontWeight: 700, marginBottom: '0.375rem' }}>
                    Input sent to Evaluation Agent · {s.evaluationInput.length} timeline event{s.evaluationInput.length === 1 ? '' : 's'}
                  </div>
                  <div style={{ color: '#6b7280', fontSize: '0.65rem', marginBottom: '0.375rem' }}>
                    Session timeline only; system prompt is excluded.
                  </div>
                  <div style={{ maxHeight: '16rem', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                    {s.evaluationInput.map((event) => (
                      <div key={event.eventId} style={{ padding: '0.375rem', backgroundColor: '#111827', borderLeft: '2px solid #475569', lineHeight: 1.4, wordBreak: 'break-word' }}>
                        <div style={{ color: '#cbd5e1', fontWeight: 700 }}>Event #{event.eventId} · {event.eventType}</div>
                        {event.actionDescription && <div><span style={{ color: '#6b7280' }}>Action: </span>{event.actionDescription}</div>}
                        {event.speech && <div><span style={{ color: '#6b7280' }}>Speech: </span>{event.speech}</div>}
                        {event.userMessage && <div><span style={{ color: '#6b7280' }}>User message: </span>{event.userMessage}</div>}
                        {event.aiResponse && <div><span style={{ color: '#6b7280' }}>AI response: </span>{event.aiResponse}</div>}
                      </div>
                    ))}
                  </div>
                  <div style={{ color: '#93c5fd', fontWeight: 700, marginTop: '0.5rem', marginBottom: '0.25rem' }}>
                    Current partition output
                  </div>
                  {!s.evaluationMoves || s.evaluationMoves.length === 0 ? (
                    <div style={{ color: '#fbbf24' }}>No move returned for this partition.</div>
                  ) : (
                    s.evaluationMoves.map((move, outputIndex) => (
                      <div key={`${move.moveType}-${outputIndex}`} style={{ color: '#d1d5db', marginTop: '0.125rem', lineHeight: 1.4 }}>
                        Type {move.moveType}{move.orientation ? ` · ${move.orientation}` : ''}: {move.description}
                      </div>
                    ))
                  )}
                  {s.evaluationRaw !== undefined && (
                    <details style={{ marginTop: '0.5rem' }}>
                      <summary style={{ color: '#93c5fd', cursor: 'pointer' }}>Raw model response / parser detail</summary>
                      <pre style={{ margin: '0.375rem 0 0', padding: '0.375rem', maxHeight: '10rem', overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: '#111827', color: '#d1d5db', fontSize: '0.65rem' }}>
                        {typeof s.evaluationRaw === 'string' ? s.evaluationRaw : JSON.stringify(s.evaluationRaw, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              )}
              {s.moves && s.moves.length > 0 && (
                <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.375rem' }}>
                  {s.agent === 'evaluation_agent' && s.status === 'completed' && (
                    <div style={{ color: '#6b7280', fontSize: '0.65rem' }}>
                      Cumulative content ledger (not just this partition)
                    </div>
                  )}
                  {s.moves.map((move) => (
                    <div
                      key={`move-${move.moveId}`}
                      style={{
                        padding: '0.375rem 0.5rem',
                        borderLeft: '2px solid #60a5fa',
                        backgroundColor: '#172033',
                        color: '#d1d5db',
                        lineHeight: 1.4,
                        wordBreak: 'break-word',
                      }}
                    >
                      <div style={{ color: '#93c5fd', fontWeight: 700 }}>
                        Move {move.contentMoveNumber} · Type {move.moveType} · {move.moveTypeName}{move.orientation ? ` · ${move.orientation}` : ''}
                      </div>
                      <div style={{ color: '#6b7280', fontSize: '0.65rem', marginTop: '0.125rem' }}>
                        Ledger move #{move.moveId}
                      </div>
                      <div style={{ marginTop: '0.125rem' }}>{move.description}</div>
                    </div>
                  ))}
                </div>
              )}
              {s.moveCounts && (
                <div style={{ color: '#d1d5db', marginTop: '0.25rem' }}>
                  D-moves: {s.moveCounts.d} | C-moves: {s.moveCounts.c}
                </div>
              )}
              {s.streak && (
                <div style={{ color: '#9ca3af', marginTop: '0.125rem' }}>
                  Current streak: {s.streak.orientation ?? 'none'} x {s.streak.count}
                </div>
              )}
              <div style={{ color: '#4b5563', fontSize: '0.65rem', marginTop: '0.125rem' }}>
                {new Date(s.timestamp).toLocaleTimeString()}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default DebugPanel;
