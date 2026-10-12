/** Independent D/C classifier used by the Controller after each user turn. */
import OpenAI from 'openai';
import { Orientation } from './manipulationController';
import { TimelineEvent } from '../services/eventTimelineBuilder';

export interface DecisionContextMove {
  moveId: number;
  moveType: number;
  orientation: Orientation;
  description: string | null;
}

export interface DecisionResult {
  orientation: Orientation;
  reasoning: string;
  raw: unknown;
  usedFallback: boolean;
  durationMs: number;
  modelUsed: string;
}

const DECISION_SYSTEM_PROMPT = `You determine the orientation of the newest design move in an adult-learning platform proposal session.

Return D (divergent) when the newest move primarily introduces a genuinely new idea or direction. Return C (convergent) when it primarily develops, references, assesses, supports, combines, adopts, or rejects earlier ideas. Judge the actual content first. Evaluate, Adopt, and Reject moves are only a weak prior toward C, never a hard rule.

Use the prior move sequence for context, but classify only the newest design move represented in the current partition. Return only JSON: {"orientation":"D"|"C","reasoning":"brief explanation"}.`;

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function fallbackOrientation(partition: TimelineEvent[]): Orientation {
  const content = partition.map((event) => `${event.speech} ${event.userMessage} ${event.actionDescription}`).join(' ').toLowerCase();
  return /\b(evaluate|assess|compare|adopt|use|combine|merge|reject|delete|disagree)\b/.test(content) ? 'C' : 'D';
}

export async function decideCurrentOrientation(partition: TimelineEvent[], previousMoves: DecisionContextMove[], timeoutMs = 12_000): Promise<DecisionResult> {
  const start = Date.now();
  const model = process.env.DECISION_MODEL || 'gpt-4o-mini';
  const prompt = `Previous labeled move sequence:\n${JSON.stringify(previousMoves)}\n\nCurrent partition:\n${JSON.stringify(partition)}`;
  try {
    const completion = await withTimeout(getOpenAI().chat.completions.create({
      model,
      messages: [{ role: 'system', content: DECISION_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 160,
    }), timeoutMs);
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = JSON.parse(raw) as { orientation?: unknown; reasoning?: unknown };
    if (parsed.orientation === 'D' || parsed.orientation === 'C') {
      return { orientation: parsed.orientation, reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '', raw, usedFallback: false, durationMs: Date.now() - start, modelUsed: model };
    }
    throw new Error('Decision Agent returned no valid orientation');
  } catch (error) {
    return {
      orientation: fallbackOrientation(partition),
      reasoning: error instanceof Error ? `Fallback: ${error.message}` : 'Fallback orientation heuristic',
      raw: { error: error instanceof Error ? error.message : String(error) },
      usedFallback: true,
      durationMs: Date.now() - start,
      modelUsed: `${model} (fallback)`,
    };
  }
}
