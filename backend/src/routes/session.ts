import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { parseGroupId, initManipulationState, getManipulationState, advancePhase } from '../agents/manipulationController';
import { finalizeSessionTimeline } from '../services/manipulationPipeline';
import { buildSessionTimeline } from '../services/eventTimelineBuilder';
import { isPracticeSession } from '../utils/sessionUtils';

const router = express.Router();

// Low-TF Phase 1 ("collect") must run at least this long before a participant can advance to Phase 2 ("synthesize").
const MIN_COLLECT_PHASE_MS = 5 * 60 * 1000; // 5 minutes
const PRACTICE_MIN_COLLECT_PHASE_MS = 90 * 1000; // 1.5 minutes

// POST /api/session/create - Create a new session
router.post('/create', async (req, res) => {
  try {
    const { sessionId: customSessionId, participantId, groupId: rawGroupId, sessionStartTimestamp } = req.body;
    const db = (req as any).db;

    if (!participantId) {
      return res.status(400).json({ error: 'Participant ID is required' });
    }

    // Paper 2: parse + validate the participant-entered group id (manipulation condition).
    // Omitting groupId entirely is allowed (e.g. practice sessions, legacy callers) — the
    // session is simply created without a manipulation_state row, and the new pipeline
    // in chat.ts/manipulationPipeline.ts leaves such sessions completely untouched.
    let condition = null;
    if (rawGroupId !== undefined && rawGroupId !== null && rawGroupId !== '') {
      condition = parseGroupId(rawGroupId);
      if (!condition) {
        return res.status(400).json({
          error: 'Invalid group ID',
          message: `"${rawGroupId}" is not a recognized group id. Expected a group code 1-5.`,
        });
      }
    }

    // Use custom sessionId if provided, otherwise generate new one
    const sessionId = customSessionId || uuidv4();

    if (!db) {
      console.log('Demo mode: Session created but not saved to database');
      return res.json({
        sessionId,
        participantId,
        groupId: condition?.groupId ?? null,
        status: 'active',
        createdAt: new Date().toISOString(),
      });
    }

    const clientStart = Number(sessionStartTimestamp);
    const metadata = Number.isFinite(clientStart) && clientStart > 0
      ? JSON.stringify({ sessionStartEpochMs: clientStart })
      : null;
    await db.execute(
      `INSERT INTO sessions (id, participant_id, group_id, status, metadata)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         participant_id = VALUES(participant_id),
         group_id = VALUES(group_id),
         status = VALUES(status),
         metadata = COALESCE(VALUES(metadata), metadata)`,
      [sessionId, participantId, condition?.groupId ?? null, 'active', metadata]
    );

    // Paper 2: initialize the manipulation_state row for this session's condition.
    // Skipped entirely when no valid groupId was given (see comment above).
    if (condition) {
      await initManipulationState(db, sessionId, condition);
    }

    console.log(`Session created: ${sessionId} for user: ${participantId}${condition ? ` (group: ${condition.groupId})` : ''}`);

    res.json({
      sessionId,
      participantId,
      groupId: condition?.groupId ?? null,
      status: 'active',
      createdAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Create session error:', error);
    res.status(500).json({
      error: 'Failed to create session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/session/:sessionId/advance-phase - Low-TF only: advance from Phase 1 (collect) to Phase 2 (synthesize)
router.post('/:sessionId/advance-phase', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    if (!db) {
      return res.status(400).json({ error: 'Database not available' });
    }

    const state = await getManipulationState(db, sessionId);
    if (!state) {
      return res.status(404).json({
        error: 'No manipulation state for this session',
        message: 'This session was not created with a manipulation group id, so there is no phase to advance.',
      });
    }

    if (state.phase !== 'collect') {
      return res.json({
        advanced: false,
        phase: state.phase,
        message: state.phase === 'synthesize'
          ? 'Session has already advanced to the synthesize phase.'
          : 'This session is not phase-gated (not a Low-TF condition).',
      });
    }

    // Phase "collect" begins when the session itself starts (manipulation_state has no
    // separate created_at column, and initManipulationState is called synchronously in
    // POST /create), so sessions.started_at is the phase-1 clock.
    const [sessionRows] = await db.execute('SELECT started_at FROM sessions WHERE id = ?', [sessionId]);
    const sessionRow = (sessionRows as any[])[0];
    if (!sessionRow) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const startedAtMs = new Date(sessionRow.started_at).getTime();
    const elapsedMs = Date.now() - startedAtMs;
    const minimumPhaseMs = isPracticeSession(sessionId)
      ? PRACTICE_MIN_COLLECT_PHASE_MS
      : MIN_COLLECT_PHASE_MS;

    if (elapsedMs < minimumPhaseMs) {
      return res.status(403).json({
        advanced: false,
        error: 'Too early to advance',
        message: `The collect phase must run for at least ${minimumPhaseMs / 60_000} minute${minimumPhaseMs === 60_000 ? '' : 's'} before advancing.`,
        remainingMs: minimumPhaseMs - elapsedMs,
      });
    }

    // Materialize all currently persisted Phase 1 data before setting the cursor at this
    // boundary. That guarantees both the streak and the evaluator's next partition begin
    // fresh in Phase 2, even if some Phase 1 speech/logs were not yet evaluated.
    const phaseOneEvents = await buildSessionTimeline(db, sessionId);
    const phaseBoundaryEventId = phaseOneEvents.length > 0
      ? phaseOneEvents[phaseOneEvents.length - 1].eventId
      : 0;
    await advancePhase(db, sessionId, phaseBoundaryEventId);
    const updated = await getManipulationState(db, sessionId);

    // This is the authoritative phase-boundary record. The client separately logs
    // the Next and Confirm clicks before this request; recording completion here
    // means an entered Phase 2 remains visible even if the browser closes before
    // it can send a post-response event.
    try {
      await db.execute(
        `INSERT INTO interaction_logs
         (session_id, event_type, action, target_element, target_section, metadata, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          sessionId,
          'ui',
          'phase_transition_completed',
          'phase-transition',
          'writing',
          JSON.stringify({
            actionType: 'phase_transition_completed',
            source: 'server',
            fromPhase: 'collect',
            toPhase: updated?.phase ?? 'synthesize',
            phaseAdvancedAt: updated?.phase_advanced_at ?? new Date().toISOString(),
          }),
          Math.max(0, Date.now() - startedAtMs),
        ]
      );
    } catch (loggingError) {
      // Advancing is already durable; an audit-log write failure must not reverse it.
      console.error('Failed to record completed phase transition:', loggingError);
    }

    res.json({
      advanced: true,
      phase: updated?.phase ?? 'synthesize',
      phaseAdvancedAt: updated?.phase_advanced_at ?? new Date().toISOString(),
    });

  } catch (error) {
    console.error('Advance phase error:', error);
    res.status(500).json({
      error: 'Failed to advance phase',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/session/:sessionId/manipulation-state - Paper 2: expose condition/phase info for the frontend UI
// (used to decide whether to show the Low-TF two-phase lock UI, and to render the "Next" button).
router.get('/:sessionId/manipulation-state', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    if (!db) {
      return res.json({ enabled: false });
    }

    const state = await getManipulationState(db, sessionId);
    if (!state) {
      return res.json({ enabled: false });
    }

    const [sessionRows] = await db.execute('SELECT started_at FROM sessions WHERE id = ?', [sessionId]);
    const sessionRow = (sessionRows as any[])[0];

    res.json({
      enabled: true,
      tfLevel: state.tf_level,
      tmLevel: state.tm_level,
      isControl: !!state.is_control,
      phase: state.phase,
      phaseAdvancedAt: state.phase_advanced_at,
      sessionStartedAt: sessionRow?.started_at ?? null,
      minCollectPhaseMs: MIN_COLLECT_PHASE_MS,
    });

  } catch (error) {
    console.error('Get manipulation state error:', error);
    res.status(500).json({
      error: 'Failed to retrieve manipulation state',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/session/:sessionId - Get session details
router.get('/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    const [rows] = await db.execute(
      'SELECT * FROM sessions WHERE id = ?',
      [sessionId]
    );

    if ((rows as any[]).length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = (rows as any[])[0];
    session.metadata = session.metadata ? JSON.parse(session.metadata) : {};

    res.json(session);

  } catch (error) {
    console.error('Get session error:', error);
    res.status(500).json({
      error: 'Failed to retrieve session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// PUT /api/session/:sessionId/status - Update session status
router.put('/:sessionId/status', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { status } = req.body;
    const db = (req as any).db;

    if (!['active', 'completed', 'abandoned'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: active, completed, or abandoned' });
    }

    const endedAt = status !== 'active' ? new Date() : null;

    await db.execute(
      'UPDATE sessions SET status = ?, ended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, endedAt, sessionId]
    );

    res.json({
      sessionId,
      status,
      endedAt: endedAt?.toISOString() || null,
      updatedAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Update session status error:', error);
    res.status(500).json({
      error: 'Failed to update session status',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// POST /api/session/:sessionId/submit - Submit final work for session
router.post('/:sessionId/submit', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { content } = req.body;
    const db = (req as any).db;

    if (!content) {
      return res.status(400).json({ error: 'Content is required' });
    }

    const wordCount = content.trim().split(/\s+/).length;
    const charCount = content.length;

    // Insert submission
    await db.execute(
      'INSERT INTO submissions (session_id, content, word_count, char_count) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE content = VALUES(content), word_count = VALUES(word_count), char_count = VALUES(char_count), submitted_at = CURRENT_TIMESTAMP',
      [sessionId, content, wordCount, charCount]
    );

    try {
      await finalizeSessionTimeline(db, sessionId);
    } catch (timelineError) {
      console.error('Final event-timeline evaluation failed:', timelineError);
    }

    // Mark session as completed
    await db.execute(
      'UPDATE sessions SET status = ?, ended_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      ['completed', sessionId]
    );

    res.json({
      sessionId,
      submitted: true,
      wordCount,
      charCount,
      submittedAt: new Date().toISOString(),
    });

  } catch (error) {
    console.error('Submit session error:', error);
    res.status(500).json({
      error: 'Failed to submit session',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/session/:sessionId/export - Export all session data
router.get('/:sessionId/export', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const db = (req as any).db;

    // Get session details
    const [sessionRows] = await db.execute(
      'SELECT * FROM sessions WHERE id = ?',
      [sessionId]
    );

    if ((sessionRows as any[]).length === 0) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const session = (sessionRows as any[])[0];
    session.metadata = session.metadata ? JSON.parse(session.metadata) : {};

    // Get transcript
    const [transcriptRows] = await db.execute(
      'SELECT content, timestamp FROM transcripts WHERE session_id = ? ORDER BY timestamp DESC LIMIT 1',
      [sessionId]
    );

    // Get messages
    const [messageRows] = await db.execute(
      'SELECT role, content, model_slug, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC',
      [sessionId]
    );

    // Get submission
    const [submissionRows] = await db.execute(
      'SELECT content, word_count, char_count, submitted_at FROM submissions WHERE session_id = ?',
      [sessionId]
    );

    // Get interaction stats
    const [statsRows] = await db.execute(
      `SELECT
         event_type,
         COUNT(*) as count,
         MIN(timestamp) as first_interaction,
         MAX(timestamp) as last_interaction
       FROM interaction_logs
       WHERE session_id = ?
       GROUP BY event_type`,
      [sessionId]
    );

    // Paper 2: manipulation state + move ledger + agent execution trace, when present
    const [manipulationStateRows] = await db.execute(
      'SELECT * FROM manipulation_state WHERE session_id = ?',
      [sessionId]
    );
    const [moveLedgerRows] = await db.execute(
      'SELECT move_id, move_type, orientation, description, turn_index, created_at FROM move_ledger WHERE session_id = ? ORDER BY move_id ASC',
      [sessionId]
    );
    const [agentExecutionRows] = await db.execute(
      'SELECT turn_index, agent_name, step_order, input_payload, output_payload, model_used, started_at, completed_at, duration_ms, status, error_message, retry_count FROM agent_execution_log WHERE session_id = ? ORDER BY id ASC',
      [sessionId]
    );

    const exportData = {
      session,
      transcript: (transcriptRows as any[])[0] || null,
      messages: messageRows,
      submission: (submissionRows as any[])[0] || null,
      interactionStats: statsRows,
      manipulationState: (manipulationStateRows as any[])[0] || null,
      moveLedger: moveLedgerRows,
      agentExecutionLog: agentExecutionRows,
      exportedAt: new Date().toISOString(),
    };

    res.json(exportData);

  } catch (error) {
    console.error('Export session error:', error);
    res.status(500).json({
      error: 'Failed to export session data',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// GET /api/session/participant/:participantId - Get all sessions for a participant
router.get('/participant/:participantId', async (req, res) => {
  try {
    const { participantId } = req.params;
    const db = (req as any).db;

    const [rows] = await db.execute(
      'SELECT id, status, started_at, ended_at, metadata FROM sessions WHERE participant_id = ? ORDER BY started_at DESC',
      [participantId]
    );

    const sessions = (rows as any[]).map(session => ({
      ...session,
      metadata: session.metadata ? JSON.parse(session.metadata) : {},
    }));

    res.json({
      participantId,
      sessions,
      count: sessions.length,
    });

  } catch (error) {
    console.error('Get participant sessions error:', error);
    res.status(500).json({
      error: 'Failed to retrieve participant sessions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
