/** Coordinates the real-time timeline, Evaluation Agent, optional Decision Agent, and Controller. */
import mysql from 'mysql2/promise';
import { evaluateTimelinePartition, EvaluationResult, hasSubstantiveParticipantContent } from '../agents/moveTypeEvaluator';
import { decideCurrentOrientation, DecisionContextMove, DecisionResult } from '../agents/decisionAgent';
import { buildSessionTimeline, TimelineEvent, unevaluatedTail } from './eventTimelineBuilder';
import { runManipulationController, getManipulationState, EvaluatedMove, ControllerInstruction, guidanceGenerationDebugInput, MOVE_TYPE_NAMES } from '../agents/manipulationController';

type SqlExecutor = Pick<mysql.Pool, 'execute'>;

export interface PipelineResult {
  ran: boolean;
  instruction?: ControllerInstruction;
  guidanceText?: string;
  guidance?: ControllerInstruction['guidance'];
  turnIndex?: number;
}

export interface DebugMove {
  moveId: number;
  contentMoveNumber: number;
  moveType: number;
  moveTypeName: string;
  orientation?: 'D' | 'C';
  description: string;
  eventIdStart?: number;
  eventIdEnd?: number;
}

export interface AgentStageEvent {
  agent: 'evaluation_agent' | 'decision_agent' | 'manipulation_controller' | 'main_response_agent';
  status: 'started' | 'completed' | 'error';
  detail?: string;
  /** Model that handled this agent invocation, including an explicit fallback label. */
  modelUsed?: string | null;
  // Test-mode only diagnostic payload. This is the timeline partition supplied to
  // the evaluator, never its system prompt or any hidden model instructions.
  evaluationInput?: TimelineEvent[];
  // The current partition's raw evaluator output. `moves` below remains the
  // cumulative content ledger shown in the panel.
  evaluationMoves?: EvaluatedMove[];
  // Test-mode diagnostic output from the model/parser, including a fallback
  // reason when no model response was available.
  evaluationRaw?: unknown;
  /** Exact prompt payload supplied to the guidance-generation LLM for an intervention. */
  guidanceGenerationInput?: {
    systemPrompt: string;
    runtimeInput: string;
    selectedMoveDescriptions: Array<{ moveId: number; moveType: number; orientation: 'D' | 'C'; description: string }>;
    recentWritingContext: Array<{ type: 'added' | 'removed' | 'revised'; content: string }>;
  };
  /** Exact messages supplied to generate the visible AI-response portion of a guidance card. */
  guidanceResponseInput?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  /** Full three-part guidance card, retained for test-mode auditing only. */
  guidanceCard?: {
    displaySummary: string;
    directionGuidance: string;
    previousIdeas: string[];
    response: string;
  };
  moves?: DebugMove[];
  moveCounts?: { d: number; c: number };
  streak?: { orientation: 'D' | 'C' | null; count: number; suppressionRemaining?: number };
  timestamp: number;
}
export type OnStage = (stage: AgentStageEvent) => void;

type AgentName = AgentStageEvent['agent'];
type AgentStatus = 'success' | 'error' | 'timeout' | 'fallback_used';

// Keep the independent D/C experiment available, but use the Evaluation Agent's
// move-type mapping as the production path until that experiment is validated.
const DECISION_AGENT_ENABLED = process.env.ENABLE_DECISION_AGENT === 'true';
const activePipelines = new Map<string, Promise<PipelineResult>>();

interface LogParams {
  sessionId: string;
  turnIndex: number;
  agentName: AgentName;
  stepOrder: number;
  input: unknown;
  output: unknown;
  modelUsed: string | null;
  startedAt: Date;
  completedAt: Date;
  status: AgentStatus;
  errorMessage?: string;
  retryCount?: number;
}

interface PipelineInitiation {
  triggerType: 'chat_send' | 'automatic_analysis' | 'final_submission';
  reason: string;
}

interface EvaluationAuditParams {
  sessionId: string;
  turnIndex: number;
  initiation: PipelineInitiation;
  evaluation: EvaluationResult;
  evaluationInput: unknown;
  evaluationStartedAt: Date;
  evaluationCompletedAt: Date;
  controllerInput?: unknown;
  controllerOutput?: unknown;
  controllerModelUsed?: string | null;
  controllerStartedAt?: Date;
  controllerCompletedAt?: Date;
  controllerStatus: AgentStatus | 'not_run';
  controllerErrorMessage?: string;
  /** Full AI-guidance decision attached to the evaluator-centred audit record. */
  aiGuidance?: unknown;
  stateBefore: Awaited<ReturnType<typeof getManipulationState>>;
  stateAfter: Awaited<ReturnType<typeof getManipulationState>>;
  moveLedgerCountBefore: number;
  moveLedgerCountAfter: number;
  moveLedgerDelta: unknown;
}

interface PersistedMove {
  rowId: number;
  moveId: number;
  move: EvaluatedMove;
}

function safeStringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function logAgentExecution(db: mysql.Pool, p: LogParams): Promise<void> {
  await db.execute(
    `INSERT INTO agent_execution_log
       (session_id, turn_index, agent_name, step_order, input_payload, output_payload, model_used,
        started_at, completed_at, duration_ms, status, error_message, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [p.sessionId, p.turnIndex, p.agentName, p.stepOrder, safeStringify(p.input), safeStringify(p.output), p.modelUsed, p.startedAt, p.completedAt, p.completedAt.getTime() - p.startedAt.getTime(), p.status, p.errorMessage ?? null, p.retryCount ?? 0]
  );
}

/**
 * Keep a durable, evaluator-centred record for later research audit/export.  This is
 * deliberately separate from agent_execution_log: it joins one evaluation with the
 * Controller outcome, exact ledger delta, and before/after streak in one immutable row.
 */
async function logEvaluationAudit(db: SqlExecutor, p: EvaluationAuditParams): Promise<void> {
  const before = p.stateBefore;
  const after = p.stateAfter;
  const controllerDuration = p.controllerStartedAt && p.controllerCompletedAt
    ? p.controllerCompletedAt.getTime() - p.controllerStartedAt.getTime()
    : null;
  await db.execute(
    `INSERT INTO evaluation_agent_audit
       (session_id, turn_index, trigger_type, trigger_reason,
        evaluation_input_payload, evaluation_output_payload, evaluation_model_used,
        evaluation_started_at, evaluation_completed_at, evaluation_duration_ms,
        evaluation_status, evaluation_retry_count,
        controller_input_payload, controller_output_payload, controller_model_used,
        controller_started_at, controller_completed_at, controller_duration_ms, controller_status, controller_error_message,
        controller_turn_count_before, controller_turn_count_after,
        move_ledger_count_before, move_ledger_count_after, move_ledger_delta,
        streak_orientation_before, streak_count_before, streak_suppression_remaining_before,
        streak_orientation_after, streak_count_after, streak_suppression_remaining_after)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      p.sessionId, p.turnIndex, p.initiation.triggerType, p.initiation.reason,
      safeStringify(p.evaluationInput), safeStringify({ moves: p.evaluation.moves, raw: p.evaluation.raw, aiGuidance: p.aiGuidance ?? null }), p.evaluation.modelUsed,
      p.evaluationStartedAt, p.evaluationCompletedAt, p.evaluationCompletedAt.getTime() - p.evaluationStartedAt.getTime(),
      evaluationLogStatus(p.evaluation), p.evaluation.retryCount,
      p.controllerInput === undefined ? null : safeStringify(p.controllerInput),
      p.controllerOutput === undefined ? null : safeStringify(p.controllerOutput),
      p.controllerModelUsed ?? null, p.controllerStartedAt ?? null, p.controllerCompletedAt ?? null,
      controllerDuration, p.controllerStatus, p.controllerErrorMessage ?? null,
      before?.turn_count ?? null, after?.turn_count ?? null,
      p.moveLedgerCountBefore, p.moveLedgerCountAfter, safeStringify(p.moveLedgerDelta),
      before?.streak_orientation ?? null, before?.streak_count ?? null, before?.streak_suppression_remaining ?? null,
      after?.streak_orientation ?? null, after?.streak_count ?? null, after?.streak_suppression_remaining ?? null,
    ]
  );
}

async function appendMoveLedger(db: SqlExecutor, sessionId: string, turnIndex: number, moves: EvaluatedMove[]): Promise<PersistedMove[]> {
  if (moves.length === 0) return [];
  const [rows] = await db.execute('SELECT COALESCE(MAX(move_id), 0) AS maxId FROM move_ledger WHERE session_id = ?', [sessionId]);
  let nextMoveId = Number((rows as any[])[0]?.maxId ?? 0) + 1;
  const persisted: PersistedMove[] = [];
  for (const move of moves) {
    const [result] = await db.execute(
      `INSERT INTO move_ledger (session_id, move_id, move_type, orientation, description, event_id_start, event_id_end, turn_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, nextMoveId, move.moveType, move.orientation ?? (move.moveType === 1 || move.moveType === 2 || move.moveType === 5 ? 'D' : 'C'), move.description ?? null, move.eventIdStart ?? null, move.eventIdEnd ?? null, turnIndex]
    );
    persisted.push({ rowId: Number((result as any).insertId), moveId: nextMoveId, move });
    nextMoveId += 1;
  }
  return persisted;
}

async function priorDecisionMoves(db: mysql.Pool, sessionId: string): Promise<DecisionContextMove[]> {
  const [rows] = await db.execute(
    `SELECT move_id, move_type, orientation, description FROM move_ledger
     WHERE session_id = ? AND description LIKE '%[Decision Agent]%'
     ORDER BY move_id ASC`,
    [sessionId]
  );
  return (rows as any[]).map((row) => ({ moveId: Number(row.move_id), moveType: Number(row.move_type), orientation: row.orientation, description: row.description }));
}

async function cumulativeContentMoveCounts(db: SqlExecutor, sessionId: string): Promise<{ d: number; c: number }> {
  const [rows] = await db.execute(
    `SELECT move_type, COUNT(*) AS count
     FROM move_ledger
     WHERE session_id = ? AND move_type IN (1, 3, 4, 6)
     GROUP BY move_type`,
    [sessionId]
  );
  const counts = { d: 0, c: 0 };
  for (const row of rows as any[]) {
    if (Number(row.move_type) === 1) counts.d += Number(row.count);
    else counts.c += Number(row.count);
  }
  return counts;
}

function describeMoves(moves: EvaluatedMove[]): string {
  return moves.length ? moves.map((move) => `${MOVE_TYPE_NAMES[move.moveType] ?? `type ${move.moveType}`}${move.orientation ? ` (${move.orientation})` : ''}`).join(', ') : 'no moves classified';
}

async function cumulativeContentDebugMoves(db: SqlExecutor, sessionId: string): Promise<DebugMove[]> {
  const [rows] = await db.execute(
    `SELECT move_id, move_type, orientation, description, event_id_start, event_id_end
     FROM move_ledger
     WHERE session_id = ? AND move_type IN (1, 3, 4, 6)
     ORDER BY move_id ASC`,
    [sessionId]
  );
  return (rows as any[]).map((row, index) => ({
    moveId: Number(row.move_id),
    contentMoveNumber: index + 1,
    moveType: Number(row.move_type),
    moveTypeName: MOVE_TYPE_NAMES[Number(row.move_type)] ?? `Type ${row.move_type}`,
    orientation: row.orientation === 'D' || row.orientation === 'C' ? row.orientation : undefined,
    description: String(row.description ?? ''),
    eventIdStart: row.event_id_start == null ? undefined : Number(row.event_id_start),
    eventIdEnd: row.event_id_end == null ? undefined : Number(row.event_id_end),
  }));
}

function latestContentMove(moves: PersistedMove[]): PersistedMove | undefined {
  return [...moves].reverse().find(({ move }) => [1, 3, 4, 6].includes(move.moveType));
}

async function persistDecisionOrientation(db: SqlExecutor, target: PersistedMove | undefined, decision: DecisionResult): Promise<EvaluatedMove[]> {
  if (!target) return [];
  const description = `[Decision Agent] ${decision.reasoning}\n${target.move.description ?? ''}`.trim();
  await db.execute('UPDATE move_ledger SET orientation = ?, description = ? WHERE id = ?', [decision.orientation, description, target.rowId]);
  return [{ ...target.move, orientation: decision.orientation, description }];
}

function evaluationLogStatus(result: EvaluationResult): AgentStatus {
  return result.usedFallback ? 'fallback_used' : 'success';
}

/**
 * Runs after the current user message has been persisted and before main-model
 * history is loaded. By default, the Controller uses the Evaluation Agent's
 * fixed move-type-to-orientation mapping. The independent Decision Agent can
 * be re-enabled for an explicit experimental comparison.
 */
export async function runTurnPipeline(
  db: mysql.Pool,
  sessionId: string,
  userMessage: string,
  onStage?: OnStage,
  initiation: PipelineInitiation = { triggerType: 'chat_send', reason: 'Participant sent a chat prompt.' }
): Promise<PipelineResult> {
  const previous = activePipelines.get(sessionId);
  const current = (previous ? previous.catch(() => ({ ran: false })) : Promise.resolve({ ran: false }))
    .then(() => runTurnPipelineOnce(db, sessionId, userMessage, onStage, initiation));
  activePipelines.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (activePipelines.get(sessionId) === current) activePipelines.delete(sessionId);
  }
}

async function runTurnPipelineOnce(
  db: mysql.Pool,
  sessionId: string,
  userMessage: string,
  onStage: OnStage | undefined,
  initiation: PipelineInitiation
): Promise<PipelineResult> {
  const state = await getManipulationState(db, sessionId);
  if (!state) return { ran: false };

  const events = await buildSessionTimeline(db, sessionId);
  const partition = unevaluatedTail(events, Number(state.last_evaluated_event_id ?? 0));
  if (partition.length === 0) return { ran: false };

  // Automatic rules can fire after a pause even when the timeline only contains
  // a greeting, filler speech, or passive UI noise. Consume that empty tail
  // without initiating either agent; otherwise the evaluator/fallback is asked
  // to manufacture a content move from no usable session information.
  const hasInteractionSkeleton = partition.some((event) => event.userMessage.trim() || event.aiResponse.trim());
  if (!hasInteractionSkeleton && !hasSubstantiveParticipantContent(partition)) {
    const lastEventId = partition[partition.length - 1].eventId;
    await db.execute('UPDATE manipulation_state SET last_evaluated_event_id = ? WHERE session_id = ?', [lastEventId, sessionId]);
    return { ran: false };
  }
  const turnIndex = state.turn_count + 1;
  const history = DECISION_AGENT_ENABLED ? await priorDecisionMoves(db, sessionId) : [];

  onStage?.({ agent: 'evaluation_agent', status: 'started', timestamp: Date.now() });
  if (DECISION_AGENT_ENABLED) onStage?.({ agent: 'decision_agent', status: 'started', timestamp: Date.now() });
  const evalStart = new Date();
  const decisionStart = DECISION_AGENT_ENABLED ? new Date() : null;
  const evaluationPromise = evaluateTimelinePartition(partition, userMessage);
  const decisionPromise = DECISION_AGENT_ENABLED ? decideCurrentOrientation(partition, history) : null;
  const evaluation = await evaluationPromise;
  const decision = decisionPromise ? await decisionPromise : null;
  const evalEnd = new Date();
  const decisionEnd = new Date();
  const executionLogs: Promise<void>[] = [
    logAgentExecution(db, { sessionId, turnIndex, agentName: 'evaluation_agent', stepOrder: 1, input: { initiation, partition }, output: { moves: evaluation.moves, raw: evaluation.raw }, modelUsed: evaluation.modelUsed, startedAt: evalStart, completedAt: evalEnd, status: evaluationLogStatus(evaluation), retryCount: evaluation.retryCount }),
  ];
  if (decision && decisionStart) {
    executionLogs.push(logAgentExecution(db, { sessionId, turnIndex, agentName: 'decision_agent', stepOrder: 2, input: { initiation, partition, priorMoveSequence: history }, output: decision, modelUsed: decision.modelUsed, startedAt: decisionStart, completedAt: decisionEnd, status: decision.usedFallback ? 'fallback_used' : 'success' }));
  }
  await Promise.all(executionLogs);

  // A failed automatic analysis used to be able to insert moves before the Controller
  // updated its streak/cursor. Keep those writes atomic so cumulative move counts can
  // never drift away from the state used by the >= 2 trigger condition.
  const connection = await db.getConnection();
  let controllerMoves: EvaluatedMove[] = evaluation.moves;
  let moveCounts = { d: 0, c: 0 };
  let contentLedgerMoves: DebugMove[] = [];
  let moveLedgerCountBefore = 0;
  let moveLedgerDelta: unknown[] = [];
  let instruction: ControllerInstruction;
  let updatedState: Awaited<ReturnType<typeof getManipulationState>>;
  const controllerStart = new Date();
  try {
    await connection.beginTransaction();
    const [ledgerCountRows] = await connection.execute(
      'SELECT COUNT(*) AS count FROM move_ledger WHERE session_id = ?',
      [sessionId]
    );
    moveLedgerCountBefore = Number((ledgerCountRows as any[])[0]?.count ?? 0);
    const persistedMoves = await appendMoveLedger(connection, sessionId, turnIndex, evaluation.moves);
    // The default path keeps the evaluator's move-type mapping for every content move.
    // The optional experiment instead overwrites only the newest content move with an
    // independent, content-based D/C judgement.
    controllerMoves = decision
      ? await persistDecisionOrientation(connection, latestContentMove(persistedMoves), decision)
      : evaluation.moves;
    moveCounts = await cumulativeContentMoveCounts(connection, sessionId);
    contentLedgerMoves = await cumulativeContentDebugMoves(connection, sessionId);
    onStage?.({
      agent: 'evaluation_agent',
      status: 'completed',
      detail: `${evaluation.usedFallback ? `Fallback used (${evaluation.modelUsed}). ` : ''}Current partition: ${describeMoves(evaluation.moves)}. Cumulative content ledger: ${contentLedgerMoves.length} move(s).`,
      evaluationInput: partition,
      evaluationMoves: evaluation.moves,
      evaluationRaw: evaluation.raw,
      modelUsed: evaluation.modelUsed,
      moves: contentLedgerMoves,
      timestamp: Date.now(),
    });
    if (decision) {
      const decisionDetail = controllerMoves.length > 0
        ? `${decision.orientation}: ${decision.reasoning}`
        : `No content move to attach: ${decision.reasoning}`;
      onStage?.({ agent: 'decision_agent', status: 'completed', detail: decisionDetail, moveCounts, timestamp: Date.now() });
    }

    onStage?.({ agent: 'manipulation_controller', status: 'started', timestamp: Date.now() });
    instruction = await runManipulationController(connection, sessionId, turnIndex, controllerMoves);
    const lastEventId = partition[partition.length - 1].eventId;
    // Do not let an evaluator that started in Phase 1 overwrite the cursor installed
    // by a later Phase 2 transition.
    await connection.execute(
      'UPDATE manipulation_state SET last_evaluated_event_id = ? WHERE session_id = ? AND phase = ?',
      [lastEventId, sessionId, state.phase]
    );
    updatedState = await getManipulationState(connection, sessionId);
    const [deltaRows] = await connection.execute(
      `SELECT move_id, move_type, orientation, description, event_id_start, event_id_end, turn_index, created_at
       FROM move_ledger WHERE session_id = ? AND turn_index = ? ORDER BY move_id ASC`,
      [sessionId, turnIndex]
    );
    moveLedgerDelta = deltaRows as any[];
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    onStage?.({
      agent: 'manipulation_controller',
      status: 'error',
      detail: error instanceof Error ? error.message : 'Failed to commit manipulation state',
      timestamp: Date.now(),
    });
    throw error;
  } finally {
    connection.release();
  }
  const controllerEnd = new Date();
  await logAgentExecution(db, {
    sessionId,
    turnIndex,
    agentName: 'manipulation_controller',
    stepOrder: DECISION_AGENT_ENABLED ? 3 : 2,
    input: { initiation, moves: controllerMoves, orientationSource: decision ? 'decision_agent' : 'evaluation_move_type_mapping', conditionState: state },
    output: instruction,
    modelUsed: instruction.debug.guidanceModelUsed,
    startedAt: controllerStart,
    completedAt: controllerEnd,
    status: instruction.debug.guidanceUsedFallback ? 'fallback_used' : 'success',
  });
  await logEvaluationAudit(db, {
    sessionId,
    turnIndex,
    initiation,
    evaluation,
    evaluationInput: { initiation, partition },
    evaluationStartedAt: evalStart,
    evaluationCompletedAt: evalEnd,
    controllerInput: { initiation, moves: controllerMoves, orientationSource: decision ? 'decision_agent' : 'evaluation_move_type_mapping', conditionState: state },
    controllerOutput: instruction,
    controllerModelUsed: instruction.debug.guidanceModelUsed,
    controllerStartedAt: controllerStart,
    controllerCompletedAt: controllerEnd,
    controllerStatus: instruction.debug.guidanceUsedFallback ? 'fallback_used' : 'success',
    aiGuidance: {
      intervened: instruction.intervened,
      targetOrientation: instruction.targetOrientation,
      targetMagnitude: instruction.targetMagnitude,
      specification: instruction.guidanceSpec,
      visibleGuidanceMessage: instruction.guidanceText,
      structuredGuidance: instruction.guidance,
    },
    stateBefore: state,
    stateAfter: updatedState,
    moveLedgerCountBefore,
    moveLedgerCountAfter: moveLedgerCountBefore + moveLedgerDelta.length,
    moveLedgerDelta,
  });
  onStage?.({
    agent: 'manipulation_controller',
    status: 'completed',
    detail: instruction.intervened
      ? `intervened (${instruction.debug.guidanceGenerationMode}${instruction.debug.guidanceUsedFallback ? ', template fallback' : ''}): "${instruction.guidanceText}"`
      : state.is_control
        ? 'silent (control condition)'
        : `silent (current consecutive ${updatedState?.streak_orientation ?? 'none'} streak: ${updatedState?.streak_count ?? 0}; guidance threshold: >= 2${instruction.debug.contentMovesSkippedAfterGuidanceInsert > 0 ? `; skipped ${instruction.debug.contentMovesSkippedAfterGuidanceInsert} post-Insert content move(s)` : ''}${instruction.debug.streakSuppressionRemainingAfter > 0 ? `; ${instruction.debug.streakSuppressionRemainingAfter} post-Insert move(s) still suppressed` : ''})`,
    moveCounts,
    streak: {
      orientation: updatedState?.streak_orientation ?? null,
      count: updatedState?.streak_count ?? 0,
      suppressionRemaining: Number(updatedState?.streak_suppression_remaining ?? 0),
    },
    guidanceGenerationInput: instruction.guidanceSpec
      ? guidanceGenerationDebugInput(instruction.guidanceSpec)
      : undefined,
    modelUsed: instruction.debug.guidanceModelUsed,
    timestamp: Date.now(),
  });

  // Delivery is intentionally owned by chat.ts. Guidance becomes a chat message only
  // after the participant explicitly selects Insert in the persistent prompt.
  return { ran: true, instruction, guidanceText: instruction.guidanceText, guidance: instruction.guidance, turnIndex };
}

/** Analyze all new events since the durable per-session cursor, without requiring a chat Send. */
export async function runIncrementalPipeline(db: mysql.Pool, sessionId: string, onStage?: OnStage, trigger?: string): Promise<PipelineResult> {
  const state = await getManipulationState(db, sessionId);
  if (!state) return { ran: false };
  const events = await buildSessionTimeline(db, sessionId);
  const tail = unevaluatedTail(events, Number(state.last_evaluated_event_id ?? 0));

  // Speech-triggered analysis has no useful work until a completed, non-empty speech
  // segment has reached the timeline. This also makes repeated microphone-noise/silence
  // callbacks harmless when the participant has not said anything new.
  const hasNewSpeech = tail.some((event) => event.eventType === 'user_speech' && event.speech.trim().length > 0);
  if (!hasNewSpeech) return { ran: false };

  return runTurnPipeline(db, sessionId, '', onStage, {
    triggerType: 'automatic_analysis',
    reason: `Automatic analysis requested after ${trigger || 'new participant speech'}.`,
  });
}

/** Record the visible assistant response. Type 5 comes from the next partition evaluator, avoiding duplicate AI-response moves. */
export async function logMainResponseTurn(db: mysql.Pool, sessionId: string, turnIndex: number, params: { input: unknown; output: string; modelUsed: string; startedAt: Date; completedAt: Date; status: AgentStatus; errorMessage?: string; }): Promise<void> {
  await logAgentExecution(db, { sessionId, turnIndex, agentName: 'main_response_agent', stepOrder: 4, input: params.input, output: { content: params.output }, modelUsed: params.modelUsed, startedAt: params.startedAt, completedAt: params.completedAt, status: params.status, errorMessage: params.errorMessage });
}

/** Evaluates the assistant-response tail when a session ends so it is not lost. */
export async function finalizeSessionTimeline(db: mysql.Pool, sessionId: string): Promise<void> {
  const state = await getManipulationState(db, sessionId);
  if (!state) return;
  const events = await buildSessionTimeline(db, sessionId);
  const tail = unevaluatedTail(events, Number(state.last_evaluated_event_id ?? 0));
  if (tail.length === 0) return;
  const hasInteractionSkeleton = tail.some((event) => event.userMessage.trim() || event.aiResponse.trim());
  if (!hasInteractionSkeleton && !hasSubstantiveParticipantContent(tail)) {
    await db.execute('UPDATE manipulation_state SET last_evaluated_event_id = ? WHERE session_id = ?', [tail[tail.length - 1].eventId, sessionId]);
    return;
  }
  const startedAt = new Date();
  const evaluation = await evaluateTimelinePartition(tail, '');
  const completedAt = new Date();
  const initiation: PipelineInitiation = {
    triggerType: 'final_submission',
    reason: 'Final submission found an unevaluated timeline tail.',
  };
  const [beforeRows] = await db.execute('SELECT COUNT(*) AS count FROM move_ledger WHERE session_id = ?', [sessionId]);
  const moveLedgerCountBefore = Number((beforeRows as any[])[0]?.count ?? 0);
  await logAgentExecution(db, { sessionId, turnIndex: state.turn_count, agentName: 'evaluation_agent', stepOrder: 5, input: { initiation, finalTail: tail }, output: { moves: evaluation.moves, raw: evaluation.raw }, modelUsed: evaluation.modelUsed, startedAt, completedAt, status: evaluationLogStatus(evaluation), retryCount: evaluation.retryCount });
  const persisted = await appendMoveLedger(db, sessionId, state.turn_count, evaluation.moves);
  await db.execute('UPDATE manipulation_state SET last_evaluated_event_id = ? WHERE session_id = ?', [tail[tail.length - 1].eventId, sessionId]);
  const stateAfter = await getManipulationState(db, sessionId);
  await logEvaluationAudit(db, {
    sessionId,
    turnIndex: state.turn_count,
    initiation,
    evaluation,
    evaluationInput: { initiation, finalTail: tail },
    evaluationStartedAt: startedAt,
    evaluationCompletedAt: completedAt,
    controllerStatus: 'not_run',
    stateBefore: state,
    stateAfter,
    moveLedgerCountBefore,
    moveLedgerCountAfter: moveLedgerCountBefore + persisted.length,
    moveLedgerDelta: persisted.map(({ moveId, move }) => ({ moveId, ...move })),
  });
}
