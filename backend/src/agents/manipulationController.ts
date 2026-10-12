/**
 * Manipulation Controller (Paper 2)
 *
 * A deterministic state machine + fixed policy table — NOT an LLM agent.
 * Reads the experimental condition (Transition Frequency / Transition Magnitude,
 * or control) plus the most recently classified moves for this turn's partition,
 * and decides whether to intervene this turn with a visible guidance message for
 * the Main Response Agent (and, by extension, the participant).
 *
 * Design reference: PAPER2_MANIPULATION_PLAN.md (v5) sections 1, 2, 8.
 *
 * Key rules (confirmed with Julia):
 * - No "light nudge" tier: the Controller either fires one strong intervention,
 *   or stays completely silent this turn.
 * - "Cooldown" is not a separate timer — firing an intervention resets the
 *   streak counter to zero, so the next intervention needs 2 fresh consecutive
 *   moves in a direction before it can fire again.
 * - The streak only counts "content" moves (Generate=1, Evaluate=3, Adopt=4,
 *   Reject=6). Ask(2) and AI Response(5) are structurally always D and are
 *   excluded — otherwise ordinary chat turns would trigger the streak on their own.
 */

import mysql from 'mysql2/promise';
import OpenAI from 'openai';

type SqlExecutor = Pick<mysql.Pool, 'execute'>;

export type Orientation = 'D' | 'C';
export type TfLevel = 'high' | 'low';
export type TmLevel = 'high' | 'low';
export type Phase = 'collect' | 'synthesize' | 'na';
export type GuidanceGenerationMode = 'template' | 'llm';

export interface ManipulationCondition {
  groupId: string;
  isControl: boolean;
  tfLevel: TfLevel | null; // null when isControl
  tmLevel: TmLevel | null; // null when isControl
}

/** Move-type -> human-readable name, per pptx Slide 18 taxonomy. Used for debug/logging display only. */
export const MOVE_TYPE_NAMES: Record<number, string> = {
  1: 'Generate',
  2: 'Ask',
  3: 'Evaluate',
  4: 'Adopt',
  5: 'AIResponse',
  6: 'Reject',
};

/**
 * Move-type -> orientation, per pptx Slide 18 taxonomy. Ask/AI Response are D but excluded from streak counting.
 * TODO(Paper 2): validate whether the evaluation model can instead return a content-based D/C orientation for
 * every move; compare agreement, latency, and cost before replacing this intentionally fixed mapping.
 */
export const MOVE_TYPE_ORIENTATION: Record<number, Orientation> = {
  1: 'D', // Generate
  2: 'D', // Ask
  3: 'C', // Evaluate
  4: 'C', // Adopt
  5: 'D', // AI Response
  6: 'C', // Reject
};

/** Move types that count toward the streak. Ask(2)/AI Response(5) are excluded — see file header. */
const CONTENT_MOVE_TYPES = new Set([1, 3, 4, 6]);
const GUIDANCE_CONTEXT_MOVE_LIMIT: Record<TmLevel, number> = { low: 2, high: 5 };

export interface EvaluatedMove {
  moveType: number;
  orientation?: Orientation; // derived if omitted
  description?: string;
  eventIdStart?: number;
  eventIdEnd?: number;
}

export interface ManipulationStateRow {
  session_id: string;
  tf_level: TfLevel | null;
  tm_level: TmLevel | null;
  is_control: number | boolean;
  phase: Phase;
  phase_advanced_at: string | null;
  streak_orientation: Orientation | null;
  streak_count: number;
  /** Content moves still ignored after an explicitly inserted guidance prompt. */
  streak_suppression_remaining: number;
  turn_count: number;
  last_evaluated_event_id: number;
}

export interface ControllerInstruction {
  intervened: boolean;
  targetOrientation: Orientation | null;
  targetMagnitude: TmLevel | null;
  guidanceText: string;
  /** Diagnostic info, useful for agent_execution_log.output_payload and debugging. */
  debug: {
    streakOrientationBefore: Orientation | null;
    streakCountBefore: number;
    streakOrientationAfter: Orientation | null;
    streakCountAfter: number;
    streakSuppressionRemainingBefore: number;
    streakSuppressionRemainingAfter: number;
    contentMovesSkippedAfterGuidanceInsert: number;
    phase: Phase;
    contentMovesConsidered: number;
    guidanceGenerationMode: GuidanceGenerationMode;
    guidanceModelUsed: string | null;
    guidanceUsedFallback: boolean;
  };
}

const VALID_GROUP_IDS = ['hightf_hightm', 'hightf_lowtm', 'lowtf_hightm', 'lowtf_lowtm', 'control'];

/**
 * Numeric group codes actually handed to participants (Julia's assignment):
 * 1=control, 2=HighTF_HighTM, 3=HighTF_LowTM, 4=LowTF_HighTM, 5=LowTF_LowTM.
 * The frontend only ever collects one of these digits from participants — the
 * descriptive condition names below still work too, for internal/manual testing.
 */
const NUMERIC_GROUP_ID_MAP: Record<string, string> = {
  '1': 'control',
  '2': 'hightf_hightm',
  '3': 'hightf_lowtm',
  '4': 'lowtf_hightm',
  '5': 'lowtf_lowtm',
};

/**
 * Parse and validate a raw group id the participant typed. Accepts either the numeric
 * code (1-5) participants are actually given, or the descriptive condition name
 * (case-insensitive, for internal/manual testing). Returns null if it matches neither.
 */
export function parseGroupId(raw: string): ManipulationCondition | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const normalized = NUMERIC_GROUP_ID_MAP[trimmed] ?? trimmed.toLowerCase();
  if (!VALID_GROUP_IDS.includes(normalized)) return null;

  if (normalized === 'control') {
    return { groupId: 'control', isControl: true, tfLevel: null, tmLevel: null };
  }
  const tfLevel: TfLevel = normalized.startsWith('hightf') ? 'high' : 'low';
  const tmLevel: TmLevel = normalized.endsWith('hightm') ? 'high' : 'low';
  const canonical = `${tfLevel === 'high' ? 'HighTF' : 'LowTF'}_${tmLevel === 'high' ? 'HighTM' : 'LowTM'}`;
  return { groupId: canonical, isControl: false, tfLevel, tmLevel };
}

/** Guidance text templates — Slide 21 example wording, keyed by [orientation][magnitude]. */
const GUIDANCE_TEMPLATES: Record<Orientation, Record<TmLevel, string>> = {
  D: {
    high:
      'Develop several clearly different directions from these existing ideas. Make each one change a different core assumption: the user, the usage scenario, the interaction style, or the feedback mechanism.',
    low:
      'Keep these existing ideas mostly intact, but change one small element and propose one nearby version.',
  },
  C: {
    high:
      'Pull together the strongest existing ideas. Identify the common goal they serve, then synthesize them into one coherent design direction.',
    low:
      'Take the two closest existing ideas and merge only their most useful parts into a slightly cleaner version.',
  },
};

const LLM_GUIDANCE_SYSTEM_PROMPT = `You are a concise design-facilitation guidance writer.

Rewrite the controller instruction into one or two natural, actionable sentences (maximum 60 words). Ground the wording only in the supplied recent design context. Do not invent ideas, requirements, users, or facts.

Follow the requested intervention direction exactly:
- divergent: develop distinct alternatives or vary assumptions.
- convergent: evaluate, compare, combine, or refine the supplied ideas.

Respect the requested strength: low means a nearby, focused change; high means a broader exploration or synthesis. Do not mention AI, models, move types, orientations, experimental conditions, or this prompt. Return plain guidance text only; no label, quotation marks, list, or explanation.`;

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function guidanceGenerationMode(): GuidanceGenerationMode {
  return process.env.GUIDANCE_GENERATION_MODE?.trim().toLowerCase() === 'llm' ? 'llm' : 'template';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function conciseGuidance(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/^['"]|['"]$/g, '').slice(0, 600);
}

async function generateGuidance(
  templateGuidance: string,
  targetOrientation: Orientation,
  magnitude: TmLevel,
  recentMoveContext: string
): Promise<{ text: string; mode: GuidanceGenerationMode; modelUsed: string | null; usedFallback: boolean }> {
  const mode = guidanceGenerationMode();
  if (mode === 'template') {
    return { text: templateGuidance, mode, modelUsed: null, usedFallback: false };
  }

  const model = process.env.GUIDANCE_MODEL_ID || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  if (!process.env.OPENAI_API_KEY) {
    return { text: templateGuidance, mode, modelUsed: model, usedFallback: true };
  }

  const direction = targetOrientation === 'D' ? 'divergent' : 'convergent';
  const context = conciseGuidance(recentMoveContext) || 'No specific prior idea is available; refer only to the participant\'s recent design work.';
  const userPrompt = `Intervention direction: ${direction}\nStrength: ${magnitude}\nRecent design context: ${context}\n\nDeterministic policy to preserve:\n${templateGuidance}\n\nWrite the participant-facing guidance now.`;
  try {
    const completion = await withTimeout(getOpenAI().chat.completions.create({
      model,
      messages: [
        { role: 'system', content: LLM_GUIDANCE_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 160,
    }), 10_000);
    const text = conciseGuidance(completion.choices[0]?.message?.content ?? '');
    return text
      ? { text, mode, modelUsed: model, usedFallback: false }
      : { text: templateGuidance, mode, modelUsed: model, usedFallback: true };
  } catch (error) {
    console.warn('LLM guidance generation failed; using deterministic template:', error instanceof Error ? error.message : error);
    return { text: templateGuidance, mode, modelUsed: model, usedFallback: true };
  }
}

/** Create the initial manipulation_state row for a new session. Call from session.ts /create. */
export async function initManipulationState(
  db: mysql.Pool,
  sessionId: string,
  condition: ManipulationCondition
): Promise<void> {
  await db.execute(
    `INSERT INTO manipulation_state
       (session_id, tf_level, tm_level, is_control, phase, streak_orientation, streak_count, streak_suppression_remaining, turn_count, last_evaluated_event_id)
     VALUES (?, ?, ?, ?, ?, NULL, 0, 0, 0, 0)
     ON DUPLICATE KEY UPDATE tf_level = VALUES(tf_level), tm_level = VALUES(tm_level), is_control = VALUES(is_control), phase = VALUES(phase)`,
    [
      sessionId,
      condition.tfLevel,
      condition.tmLevel,
      condition.isControl,
      !condition.isControl && condition.tfLevel === 'low' ? 'collect' : 'na',
    ]
  );
}

export async function getManipulationState(
  db: SqlExecutor,
  sessionId: string
): Promise<ManipulationStateRow | null> {
  const [rows] = await db.execute('SELECT * FROM manipulation_state WHERE session_id = ?', [sessionId]);
  const arr = rows as any[];
  return arr.length > 0 ? (arr[0] as ManipulationStateRow) : null;
}

/**
 * Advance a Low-TF session from the collect phase to the synthesize phase.
 * Caller (session.ts route) is responsible for the phase-duration check and provides
 * the final event ID from Phase 1 so old, not-yet-evaluated events never seed Phase 2.
 */
export async function advancePhase(db: mysql.Pool, sessionId: string, phaseBoundaryEventId: number): Promise<void> {
  await db.execute(
    `UPDATE manipulation_state
     SET phase = 'synthesize',
         phase_advanced_at = NOW(),
         streak_orientation = NULL,
         streak_count = 0,
         streak_suppression_remaining = 0,
         last_evaluated_event_id = GREATEST(COALESCE(last_evaluated_event_id, 0), ?),
         updated_at = NOW()
     WHERE session_id = ? AND phase = 'collect'`,
    [phaseBoundaryEventId, sessionId]
  );
}

/**
 * Update the streak counter with a sequence of newly-classified moves (content moves only).
 * Returns the updated {orientation, count} without persisting.
 */
function updateStreak(
  startOrientation: Orientation | null,
  startCount: number,
  moves: Orientation[]
): { orientation: Orientation | null; count: number } {
  let orientation = startOrientation;
  let count = startCount;
  for (const o of moves) {
    if (orientation === o) {
      count += 1;
    } else {
      orientation = o;
      count = 1;
    }
  }
  return { orientation, count };
}

/**
 * Main entry point: run the Controller for one turn.
 *
 * `movesThisTurn` should be the moves the Move-Type Evaluation Agent produced for the
 * partition that just closed (i.e. everything since the previous user message through
 * this new one). Only content moves (1/3/4/6) affect the streak; callers may pass the
 * full move list — this function filters it.
 */
export async function runManipulationController(
  db: SqlExecutor,
  sessionId: string,
  turnIndex: number,
  movesThisTurn: EvaluatedMove[]
): Promise<ControllerInstruction> {
  const state = await getManipulationState(db, sessionId);
  if (!state) {
    throw new Error(`manipulation_state not found for session ${sessionId} — was initManipulationState called?`);
  }

  const contentMoves = movesThisTurn.filter((m) => CONTENT_MOVE_TYPES.has(m.moveType));
  // After a participant explicitly inserts guidance, the next two content moves
  // are recorded but deliberately excluded from the Controller streak. This is
  // a per-session quota, so it continues across Evaluation Agent partitions.
  const suppressionBefore = Math.max(0, Number(state.streak_suppression_remaining) || 0);
  const contentMovesSkipped = Math.min(suppressionBefore, contentMoves.length);
  const suppressionAfter = suppressionBefore - contentMovesSkipped;
  const contentOrientations = contentMoves
    .slice(contentMovesSkipped)
    .map((m) => m.orientation ?? MOVE_TYPE_ORIENTATION[m.moveType]);

  const before = { orientation: state.streak_orientation, count: state.streak_count };
  const updated = updateStreak(before.orientation, before.count, contentOrientations);

  const isControl = !!state.is_control;
  let instruction: ControllerInstruction;

  if (isControl) {
    instruction = {
      intervened: false,
      targetOrientation: null,
      targetMagnitude: null,
      guidanceText: '',
      debug: {
        streakOrientationBefore: before.orientation,
        streakCountBefore: before.count,
        streakOrientationAfter: updated.orientation,
        streakCountAfter: updated.count,
        phase: state.phase,
        contentMovesConsidered: contentOrientations.length,
        streakSuppressionRemainingBefore: suppressionBefore,
        streakSuppressionRemainingAfter: suppressionAfter,
        contentMovesSkippedAfterGuidanceInsert: contentMovesSkipped,
        guidanceGenerationMode: guidanceGenerationMode(),
        guidanceModelUsed: null,
        guidanceUsedFallback: false,
      },
    };
  } else if (state.tf_level === 'high') {
    // High-TF (micro-cycle): fire when 2+ consecutive same-orientation content moves, push the opposite way.
    const shouldFire = updated.count >= 2 && updated.orientation !== null;
    const targetOrientation: Orientation | null = shouldFire
      ? updated.orientation === 'D'
        ? 'C'
        : 'D'
      : null;
    const recentMoveContext = shouldFire && updated.orientation
      ? await recentContentMoveContext(db, sessionId, state.tm_level ?? 'low', updated.orientation)
      : '';
    instruction = await buildInstruction(
      shouldFire,
      targetOrientation,
      state.tm_level,
      before,
      updated,
      state.phase,
      contentOrientations.length,
      suppressionBefore,
      suppressionAfter,
      contentMovesSkipped,
      recentMoveContext
    );
    if (shouldFire) {
      updated.orientation = null;
      updated.count = 0;
    }
  } else {
    // Low-TF (phase-based): phase 1 / collect targets D, so 2+ C moves trigger D guidance.
    // Phase 2 / synthesize targets C, so 2+ D moves trigger C guidance.
    const phaseTarget: Orientation = state.phase === 'synthesize' ? 'C' : 'D'; // 'collect' or 'na' defaults to D
    const offPhase = updated.orientation !== null && updated.orientation !== phaseTarget;
    const shouldFire = offPhase && updated.count >= 2;
    const recentMoveContext = shouldFire && updated.orientation
      ? await recentContentMoveContext(db, sessionId, state.tm_level ?? 'low', updated.orientation)
      : '';
    instruction = await buildInstruction(
      shouldFire,
      shouldFire ? phaseTarget : null,
      state.tm_level,
      before,
      updated,
      state.phase,
      contentOrientations.length,
      suppressionBefore,
      suppressionAfter,
      contentMovesSkipped,
      recentMoveContext
    );
    if (shouldFire) {
      updated.orientation = null;
      updated.count = 0;
    }
  }

  // Guard this write with the phase that was read above. If the participant advanced
  // while an earlier evaluator request was still running, that old request must not
  // restore the Phase 1 streak or deliver a stale, opposite-direction guidance card.
  const [updateResult] = await db.execute(
    `UPDATE manipulation_state
     SET streak_orientation = ?, streak_count = ?, streak_suppression_remaining = ?, turn_count = turn_count + 1, updated_at = NOW()
     WHERE session_id = ? AND phase = ?`,
    [updated.orientation, updated.count, suppressionAfter, sessionId, state.phase]
  );

  if (Number((updateResult as any).affectedRows ?? 0) === 0) {
    const currentState = await getManipulationState(db, sessionId);
    return {
      ...instruction,
      intervened: false,
      targetOrientation: null,
      guidanceText: '',
      debug: {
        ...instruction.debug,
        phase: currentState?.phase ?? state.phase,
        streakOrientationAfter: currentState?.streak_orientation ?? null,
        streakCountAfter: Number(currentState?.streak_count ?? 0),
        streakSuppressionRemainingAfter: Number(currentState?.streak_suppression_remaining ?? 0),
      },
    };
  }

  return instruction;
}

async function recentContentMoveContext(
  db: SqlExecutor,
  sessionId: string,
  magnitude: TmLevel,
  triggerOrientation: Orientation
): Promise<string> {
  // mysql2 prepared statements against the current server reject a placeholder
  // in LIMIT (ER_WRONG_ARGUMENTS / mysqld_stmt_execute). This value is derived
  // only from our closed TmLevel union, never from a request, so embedding the
  // validated numeric literal is safe.
  const contextLimit = GUIDANCE_CONTEXT_MOVE_LIMIT[magnitude] ?? GUIDANCE_CONTEXT_MOVE_LIMIT.low;
  const [rows] = await db.execute(
    `SELECT move_type, orientation, description
     FROM move_ledger
     WHERE session_id = ? AND move_type IN (1, 3, 4, 6) AND orientation = ?
       AND description IS NOT NULL AND description <> ''
     ORDER BY move_id DESC
     LIMIT ${contextLimit}`,
    [sessionId, triggerOrientation]
  );

  return (rows as any[])
    .reverse()
    .map((row) => String(row.description).replace(/\s+/g, ' ').trim().slice(0, 320))
    .filter(Boolean)
    .join(' ');
}

async function buildInstruction(
  intervened: boolean,
  targetOrientation: Orientation | null,
  tmLevel: TmLevel | null,
  before: { orientation: Orientation | null; count: number },
  after: { orientation: Orientation | null; count: number },
  phase: Phase,
  contentMovesConsidered: number,
  streakSuppressionRemainingBefore: number,
  streakSuppressionRemainingAfter: number,
  contentMovesSkippedAfterGuidanceInsert: number,
  recentMoveContext: string
): Promise<ControllerInstruction> {
  const magnitude = tmLevel ?? 'low';
  const normalizedContext = recentMoveContext.replace(/\s+/g, ' ').trim();
  const contextPreamble = normalizedContext
    ? `Guidance: Build from these recent ideas: ${normalizedContext}\n\n`
    : 'Guidance: Build from the recent ideas you have expressed in this discussion.\n\n';
  const templateGuidance = intervened && targetOrientation
    ? `${contextPreamble}${GUIDANCE_TEMPLATES[targetOrientation][magnitude]}`
    : '';
  const generated = intervened && targetOrientation
    ? await generateGuidance(templateGuidance, targetOrientation, magnitude, normalizedContext)
    : { text: '', mode: guidanceGenerationMode(), modelUsed: null, usedFallback: false };
  return {
    intervened,
    targetOrientation,
    targetMagnitude: intervened ? magnitude : null,
    guidanceText: generated.text,
    debug: {
      streakOrientationBefore: before.orientation,
      streakCountBefore: before.count,
      streakOrientationAfter: after.orientation,
      streakCountAfter: after.count,
      phase,
      contentMovesConsidered,
      streakSuppressionRemainingBefore,
      streakSuppressionRemainingAfter,
      contentMovesSkippedAfterGuidanceInsert,
      guidanceGenerationMode: generated.mode,
      guidanceModelUsed: generated.modelUsed,
      guidanceUsedFallback: generated.usedFallback,
    },
  };
}
