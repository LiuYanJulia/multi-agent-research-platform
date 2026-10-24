/**
 * Partition-based Move-Type Evaluation Agent.
 *
 * This keeps the Phase 1 chat-only classifier as a failure fallback, but the
 * normal path mirrors the fine-tuned offline notebook: one model call per
 * timeline partition, split at user_message boundaries, with Ask/AI Response
 * counts checked and retried.
 */
import OpenAI from 'openai';
import { EvaluatedMove, MOVE_TYPE_ORIENTATION } from './manipulationController';
import { TimelineEvent } from '../services/eventTimelineBuilder';

function getOpenAI() {
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

export interface EvaluationResult {
  moves: EvaluatedMove[];
  raw: unknown;
  usedFallback: boolean;
  durationMs: number;
  retryCount: number;
  modelUsed: string;
}

const DESCRIPTION_REQUIREMENTS = `Description requirements:
- Write one specific, declarative third-person summary sentence of at most 25 words.
- Capture the atomic idea, action, target, or decision that makes this move distinct.
- Do not quote, transcribe, or reproduce the participant's wording verbatim.
- Do not use generic labels such as "fallback content classification" or "user has an idea".`;

export const EVALUATION_SYSTEM_PROMPT = `You are an expert at analyzing design ideation sessions for linkography analysis. Segment timeline events into design moves using a two-phase approach.

PHASE 1: Extract the interaction skeleton.
- Create exactly one Ask move (type 2) for every event with a non-empty user_message.
- Create exactly one AI_Response move (type 5) for every event with a non-empty ai_response.
- Verify those counts before segmenting the remaining events.
- A type 2 Ask is permitted ONLY for an actual sent chat message in the user_message field. Do not create Ask moves for speech, typing, writing, pauses, clicks, or any user_action event.
- A type 5 AI_Response is permitted ONLY for an actual chatbot response in the ai_response field. Do not infer an AI_Response from any other event.
- If a partition has no non-empty user_message, it must contain zero Ask moves. If it has no non-empty ai_response, it must contain zero AI_Response moves.

PHASE 2: Segment remaining events.
- Generate (1): the user creates a new idea independently, including think-aloud or original writing.
- Evaluate (3): the user explicitly reviews or assesses content. Hovering with a message ID or in the response section, and selecting response text, are high-signal response-engagement evidence. Treat behavior as an Evaluate episode only when the timeline's response-engagement evidence check says that at least two hover/text-select events occurred within 10 seconds, and both refer to the response section or a message ID. When participant speech immediately precedes or follows qualifying evaluation evidence, classify the speech and engagement together as Evaluate rather than Generate. Do not infer an Evaluate move merely because an AI response arrived or a participant paused.
- Adopt (4): use this type ONLY for verifiable incorporation into the writing section. There must be either (a) events that explicitly show actions copied from an AI response and pasted into the writing section, or (b) text typed/pasted into the writing section that clearly repeats or paraphrases a supplied ai_response. Mere intention to use an idea, verbal agreement or praise (for example, "that's good"), viewing, reading, selecting, or copying alone is NOT Adopt.
- Reject (6): the user explicitly dismisses a suggestion, deletes writing, disagrees, or proposes a contradictory direction. Uncertainty, silence, greetings, filler speech, or a contribution that lacks a clear idea are NOT rejection.
- It is valid to return no content moves when the participant has not supplied a substantive idea, action, assessment, adoption, or rejection. Never invent a content move to make the array non-empty.

Reading versus independent speech:
- Response-engagement evidence for behavioral Evaluate includes only hovering over or selecting text in the response section or with a message ID. Only the qualifying two-event evidence check supports behavioral Evaluate. When it qualifies, treat speech that merely repeats, closely paraphrases, or explicitly considers a nearby AI-response idea as Evaluate, not as a new Generate move.
- A qualifying response-engagement episode supports Evaluate; it does not create Generate or Adopt. Speech such as "that's good" during a qualifying episode is Evaluate at most, never Adopt unless the timeline separately contains the required writing-incorporation evidence.

${DESCRIPTION_REQUIREMENTS}

Use chronological order. A move should represent one coherent idea or action; do not create tiny moves for incidental actions. Return ONLY a JSON array (an empty array is allowed). Each object must have sequential move_id, a specific description, and move_type (an integer from 1 to 6).`;

const STUB_SYSTEM_PROMPT = `You are a fallback classifier for a design-ideation timeline. Classify it as exactly one of generate, evaluate, adopt, or reject. Hovering with a message ID or in the response section, and selecting response text, are high-signal Evaluate evidence. Treat behavior as Evaluate evidence only when the supplied evidence check says at least two hover/text-select events occurred within 10 seconds and both refer to the response section or a message ID. If nearby speech considers, repeats, or develops an idea contained in a nearby AI response during that qualifying episode, classify it as evaluate rather than generate. Classify as adopt only when events explicitly show text copied from an AI response or response section and pasted into the writing section, or when writing text clearly repeats or paraphrases a supplied AI response. Classify as generate when the participant introduces an independent idea without qualifying response-engagement or writing-incorporation evidence. ${DESCRIPTION_REQUIREMENTS} Return only JSON: {"classification":"generate","description":"Participant proposes a career-advice platform for adults aged 25 to 40."}.`;
const CLASSIFICATION_TO_MOVE_TYPE: Record<string, number> = { generate: 1, evaluate: 3, adopt: 4, reject: 6 };
const MAX_DESCRIPTION_WORDS = 25;
const CONTENT_MOVE_TYPES = new Set([1, 3, 4, 6]);
const NON_SUBSTANTIVE_UTTERANCES = new Set([
  'hi', 'hello', 'hey', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'yeah', 'yep', 'no',
  'um', 'uh', 'erm', 'hmm', 'mm', 'ah', 'eh', 'uhh', 'umm', 'uh huh', 'mm hmm',
]);
const UNCERTAIN_OR_FILLER_ONLY = /^(?:(?:i am|i'm|im) )?(?:not sure|thinking|still thinking|just thinking|trying to think|let me think|wondering|i do not know|i don't know|dont know|no idea|let's see|lets see|well|so|right)(?: about it)?[.!?, ]*$/i;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function extractJsonArray(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || raw.match(/(\[[\s\S]*\])/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

function conciseDescription(value: string, fallback = ''): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  const words = normalized.split(' ').filter(Boolean);
  if (words.length === 0) return fallback;
  return words.length <= MAX_DESCRIPTION_WORDS
    ? normalized
    : `${words.slice(0, MAX_DESCRIPTION_WORDS).join(' ')}...`;
}

function quotedParticipantText(actionDescription: string): string[] {
  return [...actionDescription.matchAll(/(?:typed|pasted|deleted)\s+'([^']+)'/gi)].map((match) => match[1].trim());
}

function isResponseReadingAction(actionDescription: string): boolean {
  return /\b(?:hover(?:ed)?|hover_start|selected|text_select)\b/i.test(actionDescription)
    && /\bresponse section\b|\bmessage id\b/i.test(actionDescription);
}

type ResponseEvidenceCategory = 'hover' | 'selection';
interface ResponseEvidence {
  eventId: number;
  timestamp: number;
  category: ResponseEvidenceCategory;
}

const RESPONSE_EVIDENCE_WINDOW_MS = 10_000;
const REQUIRED_RESPONSE_EVIDENCE_EVENTS = 2;

function responseEvidenceCategory(actionDescription: string): ResponseEvidenceCategory | null {
  // Evidence must be traceable to the response section or a particular message.
  if (!/\bresponse section\b|\bmessage id\b/i.test(actionDescription)) return null;
  if (/\bhover(?:ed)?\b|\bhover_start\b/i.test(actionDescription)) return 'hover';
  if (/\bselected\b|\btext_select\b/i.test(actionDescription)) return 'selection';
  return null;
}

function responseEvidence(partition: TimelineEvent[]): ResponseEvidence[] {
  return partition.flatMap((event) => {
    if (event.eventType !== 'user_action') return [];
    const category = responseEvidenceCategory(event.actionDescription);
    return category ? [{ eventId: event.eventId, timestamp: event.timestampStart, category }] : [];
  });
}

function qualifyingResponseEvidence(partition: TimelineEvent[]): ResponseEvidence[] | null {
  const evidence = responseEvidence(partition);
  for (let start = 0; start < evidence.length; start += 1) {
    const window = evidence.filter((item) => item.timestamp >= evidence[start].timestamp && item.timestamp - evidence[start].timestamp <= RESPONSE_EVIDENCE_WINDOW_MS);
    if (window.length >= REQUIRED_RESPONSE_EVIDENCE_EVENTS) return window;
  }
  return null;
}

function responseEvidenceSummary(partition: TimelineEvent[]): string {
  const qualifying = qualifyingResponseEvidence(partition);
  if (qualifying) {
    const details = qualifying.map((item) => `${item.category} (Event #${item.eventId})`).join(', ');
    return `QUALIFIES FOR BEHAVIORAL EVALUATE ONLY: ${details}. At least ${REQUIRED_RESPONSE_EVIDENCE_EVENTS} hover/text-select events occurred within ${RESPONSE_EVIDENCE_WINDOW_MS / 1000} seconds, each tied to the response section or a message ID.`;
  }
  const evidence = responseEvidence(partition);
  return evidence.length
    ? `DOES NOT QUALIFY FOR BEHAVIORAL EVALUATE: ${evidence.map((item) => `${item.category} (Event #${item.eventId})`).join(', ')}. These events cannot support Evaluate, but they do not restrict classification of independent participant speech as Generate.`
    : 'NO RESPONSE-ENGAGEMENT EVENTS. This only rules out behavioral Evaluate; independently proposed participant speech can still be Generate.';
}

function hasExplicitEvaluationLanguage(partition: TimelineEvent[]): boolean {
  const participantText = partition.flatMap((event) => [event.speech, event.userMessage]).join(' ').toLowerCase();
  return /\b(?:prefer|better|worse|fits?|suitable|unsuitable|like|dislike|useful|unhelpful|pros?|cons?|trade[ -]?offs?|compar(?:e|ing)|rather than|choos(?:e|ing)|reject(?:ing)?)\b/.test(participantText);
}

function writingTextFromAction(actionDescription: string): string[] {
  if (!/\bwriting section\b/i.test(actionDescription)) return [];
  return [...actionDescription.matchAll(/(?:typed|pasted)\s+'([^']+)'/gi)].map((match) => match[1].trim());
}

function contentTokens(value: string): Set<string> {
  const ignored = new Set(['about', 'after', 'again', 'also', 'and', 'from', 'have', 'into', 'just', 'more', 'that', 'than', 'their', 'then', 'they', 'this', 'with', 'would', 'your']);
  return new Set(
    (value.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])
      .filter((token) => !ignored.has(token))
  );
}

/**
 * A Type 4 must have observable incorporation evidence, not merely an opinion
 * about the AI response.  The model still decides whether a writing excerpt is
 * a meaningful paraphrase; this check requires the necessary source and target
 * evidence before its Type 4 can reach the move ledger.
 */
function hasWritingIncorporationEvidence(partition: TimelineEvent[]): boolean {
  const descriptions = partition.map((event) => event.actionDescription || '');
  const directCopyPaste = descriptions.some((description) =>
    /copied\s+.+\s+from AI response.*pasted\s+(?:it\s+)?into writing section/i.test(description)
  );
  if (directCopyPaste) return true;

  const copiedFromResponse = descriptions.some((description) => /\bcopied\b.*\bfrom (?:AI response|response section)\b/i.test(description));
  const pastedIntoWriting = descriptions.some((description) => /\bpasted\b.*\binto writing section\b/i.test(description));
  if (copiedFromResponse && pastedIntoWriting) return true;

  const responseTokens = new Set(
    partition.flatMap((event) => [...contentTokens(event.aiResponse)])
  );
  if (responseTokens.size === 0) return false;

  return descriptions
    .flatMap(writingTextFromAction)
    .some((writtenText) => {
      const shared = [...contentTokens(writtenText)].filter((token) => responseTokens.has(token));
      // Two substantive overlapping terms are a conservative lexical floor for
      // "similar". A direct copy/paste above remains valid even without text.
      return shared.length >= 2;
    });
}

function isSubstantiveText(value: string): boolean {
  const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!normalized || NON_SUBSTANTIVE_UTTERANCES.has(normalized) || UNCERTAIN_OR_FILLER_ONLY.test(normalized)) return false;

  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const distinctWords = new Set(words);
  // A repeated greeting such as "hi, hi" has words but conveys no session content.
  if (distinctWords.size === 1 && words.length > 1) return false;

  // Two meaningful words (for example, "career platform") are enough to preserve
  // short ideas, while isolated acknowledgements are intentionally ignored.
  return words.length >= 2 || normalized.length >= 12;
}

/**
 * True only when a partition contains participant-provided material that could
 * plausibly form a content move. It deliberately excludes passive UI events,
 * pauses, greetings, and filler speech.
 */
export function hasSubstantiveParticipantContent(partition: TimelineEvent[]): boolean {
  return partition.some((event) => {
    const directText = [event.speech, event.userMessage];
    const typedText = quotedParticipantText(event.actionDescription);
    return isResponseReadingAction(event.actionDescription) || [...directText, ...typedText].some(isSubstantiveText);
  });
}

function removeUngroundedContentMoves(moves: EvaluatedMove[], partition: TimelineEvent[]): EvaluatedMove[] {
  const contentGrounded = hasSubstantiveParticipantContent(partition)
    ? moves
    : moves.filter((move) => !CONTENT_MOVE_TYPES.has(move.moveType));
  const evaluationGrounded = hasExplicitEvaluationLanguage(partition) || qualifyingResponseEvidence(partition) !== null;
  const adoptionGrounded = hasWritingIncorporationEvidence(partition)
    ? contentGrounded
    : contentGrounded.filter((move) => move.moveType !== 4);
  return adoptionGrounded
    .filter((move) => move.moveType !== 3 || evaluationGrounded);
}

function toMoves(value: unknown[] | null, partition: TimelineEvent[]): EvaluatedMove[] | null {
  if (!value) return null;
  const firstEventId = partition[0]?.eventId;
  const lastEventId = partition[partition.length - 1]?.eventId;
  const userEvents = partition.filter((event) => event.userMessage.trim());
  const responseEvents = partition.filter((event) => event.aiResponse.trim());
  const moves: EvaluatedMove[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const moveType = Number(record.move_type);
    const description = typeof record.description === 'string' ? conciseDescription(record.description) : '';
    if (!Number.isInteger(moveType) || moveType < 1 || moveType > 6 || !description) return null;
    // Type 2 and type 5 are grounded only in their corresponding timeline
    // fields.  Do this deterministically after the model responds so an
    // invented Ask/AI_Response cannot invalidate otherwise useful content
    // moves (for example, a Generate inferred from speech-only input).
    const matchedEvent = moveType === 2 ? userEvents.shift() : moveType === 5 ? responseEvents.shift() : undefined;
    if ((moveType === 2 || moveType === 5) && !matchedEvent) continue;
    moves.push({
      moveType,
      orientation: MOVE_TYPE_ORIENTATION[moveType],
      description,
      eventIdStart: matchedEvent?.eventId ?? firstEventId,
      eventIdEnd: matchedEvent?.eventId ?? lastEventId,
    });
  }
  return removeUngroundedContentMoves(moves, partition);
}

function countsMatch(moves: EvaluatedMove[], partition: TimelineEvent[]): boolean {
  const expectedAsk = partition.filter((event) => event.userMessage.trim()).length;
  const expectedResponses = partition.filter((event) => event.aiResponse.trim()).length;
  return moves.filter((move) => move.moveType === 2).length === expectedAsk && moves.filter((move) => move.moveType === 5).length === expectedResponses;
}

function hasRichSpeechOnlyContribution(partition: TimelineEvent[]): boolean {
  // A participant's sustained think-aloud is the primary source of Generate
  // moves between chat turns. Do not accept an empty model array for it simply
  // because this partition has no chat-message or AI-response skeleton rows.
  if (partition.some((event) => event.userMessage.trim() || event.aiResponse.trim())) return false;
  const words = partition
    .flatMap((event) => event.speech.match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.length >= 12;
}

/** The exact non-system prompt supplied for one Evaluation Agent model call. */
export function buildEvaluationUserPrompt(partition: TimelineEvent[], correction = ''): string {
  return `Analyze this design timeline partition.\n\nResponse-engagement evidence check:\n${responseEvidenceSummary(partition)}\n\nTimeline data:\n${JSON.stringify(partition)}${correction}`;
}

function fallbackUserMessages(partition: TimelineEvent[], userMessageForFallback: string): string[] {
  const messages = partition.map((event) => event.userMessage.trim()).filter(Boolean);
  return messages.length > 0 ? messages : userMessageForFallback.trim() ? [userMessageForFallback.trim()] : [];
}

function fallbackContent(partition: TimelineEvent[], userMessageForFallback: string): string {
  const contributions = partition.flatMap((event) => [
    event.actionDescription ? `Action: ${event.actionDescription}` : '',
    event.speech ? `Speech: ${event.speech}` : '',
    event.userMessage ? `User message: ${event.userMessage}` : '',
  ]).map((content) => content.trim()).filter(Boolean);
  if (contributions.length > 0) return `Response-engagement evidence check: ${responseEvidenceSummary(partition)}\n\n${contributions.join('\n')}`;
  return userMessageForFallback.trim();
}

function fallbackDescription(content: string): string {
  const excerpt = conciseDescription(content);
  return excerpt
    ? `Fallback summary unavailable; participant mentions: ${excerpt}`
    : 'Fallback content classification with no participant text available.';
}

async function evaluateFallback(partition: TimelineEvent[], userMessageForFallback: string, timeoutMs: number): Promise<EvaluationResult> {
  const start = Date.now();
  const userMessages = fallbackUserMessages(partition, userMessageForFallback);
  const asks: EvaluatedMove[] = userMessages.map(() => ({
    moveType: 2,
    orientation: 'D',
    description: 'User sends a chat message to the AI.',
  }));
  const responses: EvaluatedMove[] = partition.filter((event) => event.aiResponse.trim()).map(() => ({
    moveType: 5,
    orientation: 'D',
    description: 'AI provides a chat response.',
  }));
  const content = fallbackContent(partition, userMessageForFallback);
  if (!hasSubstantiveParticipantContent(partition) && !isSubstantiveText(userMessageForFallback)) {
    return {
      moves: removeUngroundedContentMoves([...asks, ...responses], partition),
      raw: { skippedContentClassification: 'No substantive participant content in partition.' },
      usedFallback: true,
      durationMs: Date.now() - start,
      retryCount: 0,
      modelUsed: 'deterministic skeleton-only fallback',
    };
  }
  try {
    const completion = await withTimeout(getOpenAI().chat.completions.create({
      model: 'gpt-5.6-terra',
      reasoning_effort: 'low',
      messages: [{ role: 'system', content: STUB_SYSTEM_PROMPT }, { role: 'user', content: content.slice(0, 1_000) }],
      response_format: { type: 'json_object' },
      // Includes low-effort reasoning plus the small JSON fallback result.
      max_completion_tokens: 250,
    }), timeoutMs);
    const raw = completion.choices[0]?.message?.content ?? '{}';
    const parsed = (() => { try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; } })();
    const classification = typeof parsed.classification === 'string' ? parsed.classification : 'generate';
    const moveType = CLASSIFICATION_TO_MOVE_TYPE[classification] ?? 1;
    const description = typeof parsed.description === 'string'
      ? conciseDescription(parsed.description, fallbackDescription(content))
      : fallbackDescription(content);
    return { moves: removeUngroundedContentMoves([...asks, ...responses, { moveType, orientation: MOVE_TYPE_ORIENTATION[moveType], description }], partition), raw, usedFallback: true, durationMs: Date.now() - start, retryCount: 0, modelUsed: 'gpt-5.6-terra (fallback)' };
  } catch (error) {
    return { moves: removeUngroundedContentMoves([...asks, ...responses, { moveType: 1, orientation: 'D', description: fallbackDescription(content) }], partition), raw: { error: error instanceof Error ? error.message : String(error) }, usedFallback: true, durationMs: Date.now() - start, retryCount: 0, modelUsed: 'deterministic fallback' };
  }
}

/** Evaluate one closed partition using EVAL_MODEL_ID, retrying at most three attempts. */
export async function evaluateTimelinePartition(partition: TimelineEvent[], userMessageForFallback: string, timeoutMs = 15_000): Promise<EvaluationResult> {
  const start = Date.now();
  const model = process.env.EVAL_MODEL_ID;
  if (!model || partition.length === 0) return evaluateFallback(partition, userMessageForFallback, timeoutMs);
  const expectedAsk = partition.filter((event) => event.userMessage.trim()).length;
  const expectedResponses = partition.filter((event) => event.aiResponse.trim()).length;
  let lastError = '';
  let bestMoves: EvaluatedMove[] | null = null;
  let raw: unknown = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const correction = lastError ? `\nThe previous output failed validation: ${lastError}. Correct it and return only the JSON array.` : '';
    const prompt = buildEvaluationUserPrompt(partition, correction);
    try {
      const completion = await withTimeout(getOpenAI().chat.completions.create({
        model,
        messages: [{ role: 'system', content: EVALUATION_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 4_096,
      }), timeoutMs);
      raw = completion.choices[0]?.message?.content ?? '';
      const moves = toMoves(extractJsonArray(String(raw)), partition);
      if (!moves) { lastError = 'The response was not a valid JSON array of complete moves.'; continue; }
      if (!countsMatch(moves, partition)) { lastError = `Expected ${expectedAsk} Ask and ${expectedResponses} AI_Response moves.`; if (!bestMoves || moves.length > bestMoves.length) bestMoves = moves; continue; }
      if (moves.length === 0 && hasRichSpeechOnlyContribution(partition)) {
        lastError = 'This speech-only partition contains a sustained participant think-aloud. Identify the concrete content move or moves; do not return an empty array.';
        continue;
      }
      return { moves, raw, usedFallback: false, durationMs: Date.now() - start, retryCount: attempt - 1, modelUsed: model };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  if (bestMoves) return { moves: bestMoves, raw: { raw, validationError: lastError }, usedFallback: true, durationMs: Date.now() - start, retryCount: 2, modelUsed: model };
  return evaluateFallback(partition, userMessageForFallback, timeoutMs);
}

// Retained for callers/tests that still name the Phase 1 fallback directly.
export async function evaluateUserTurnStub(userMessage: string, timeoutMs = 4_000): Promise<EvaluationResult> {
  return evaluateFallback([], userMessage, timeoutMs);
}
