/**
 * Builds the online equivalent of the offline behavior_narration.py +
 * design_move_separation.py pipeline. All output timestamps are epoch
 * milliseconds so interaction logs and realtime speech can be merged safely.
 */
import mysql from 'mysql2/promise';

type SqlExecutor = Pick<mysql.Pool, 'execute'>;

type EventType = 'user_action' | 'user_speech' | 'user_message' | 'ai_response';

export interface TimelineEvent {
  eventId: number;
  timestampStart: number;
  timestampEnd: number;
  eventType: EventType;
  actionDescription: string;
  speech: string;
  userMessage: string;
  aiResponse: string;
}

interface InteractionLog {
  id: number;
  event_type: string;
  action: string;
  target_element: string | null;
  target_section: string | null;
  text_content: string | null;
  metadata: unknown;
  timestamp: number;
}

type TimelineSource = 'interaction_logs' | 'speech_segments' | 'messages';

interface SessionClock {
  sessionStartEpochMs: number;
  recordingStartEpochMs: number | null;
}

interface NormalizedLog extends InteractionLog {
  absoluteTimestamp: number;
  metadataObject: Record<string, unknown>;
  category: ActionCategory;
}

type ActionCategory =
  | 'typing'
  | 'deleting'
  | 'selecting'
  | 'scrolling'
  | 'clipboard'
  | 'clicking'
  | 'hovering'
  | 'cursor'
  | 'ui_interaction'
  | 'focus'
  | 'key_press'
  | 'selection_clear'
  | 'other';

interface Behavior {
  logs: NormalizedLog[];
  category: ActionCategory;
  timestampStart: number;
  timestampEnd: number;
  narration: string | null;
  mergedSpeech: string;
}

const FILLER_TRANSCRIPTS = new Set(['', '.', 'um', 'uh', 'erm', 'hmm', 'mm', 'uhh', 'umm', 'ah', 'eh', 'uhuh', 'mmhmm']);
const activeBuilds = new Map<string, Promise<TimelineEvent[]>>();
import { inspectSessionMetadata, sessionMetadataDiagnostic } from './sessionMetadataDiagnostics';

// LOCAL DIAGNOSTICS ONLY — set TIMELINE_DIAGNOSTICS=false before pushing/deploying.
// Read at call time because dotenv is initialized after route modules load.
function timelineDiagnosticsEnabled(): boolean {
  return process.env.TIMELINE_DIAGNOSTICS === 'true';
}

export interface TimelineDiagnostics {
  traceId?: string;
  origin?: string;
}

interface TimelineDiagnosticContext extends TimelineDiagnostics {
  sessionId: string;
  stage: string;
  connectionThreadId?: number;
  [key: string]: unknown;
}

function errorSummary(error: unknown): Record<string, unknown> {
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

function timelineDiagnostic(context: TimelineDiagnosticContext): void {
  if (!timelineDiagnosticsEnabled()) return;
  // Never include transcript, chat, interaction text, or full metadata here.
  console.info('[TIMELINE_DIAGNOSTIC]', JSON.stringify({ at: new Date().toISOString(), ...context }));
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value);
}

/**
 * This normalisation is deliberately used only for the small English filler
 * vocabulary. The previous ASCII-only expression converted Chinese/Korean-only
 * speech to an empty string, which is itself a filler value, and silently
 * removed it from the timeline.
 */
function normalizeFillerCandidate(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeUiReferences(value: string): string {
  return value
    .replace(/\[data-testid="[^"]+"\]\s*/g, '')
    .replace(/(?:writing-textarea|prompting-textarea)\s+/g, '')
    .replace(/\[placeholder="Ask anything"\]/g, '(prompting section)')
    .replace(/\s+in\s+(writing|prompting|response)\s+section/g, ' ($1 section)')
    .replace(/conversation-turn-\d+\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function categoryFor(log: InteractionLog, metadata: Record<string, unknown>): ActionCategory {
  if (log.action === 'text_insert') return 'typing';
  if (log.action === 'key_press') {
    const specialKeys = new Set(['CapsLock', 'Shift', 'Control', 'Alt', 'Meta', 'Tab', 'Escape', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Insert']);
    return specialKeys.has(text(metadata.key)) || /^F\d{1,2}$/.test(text(metadata.key)) ? 'key_press' : 'typing';
  }
  if (log.action === 'text_delete') return 'deleting';
  if (log.action === 'text_select') return 'selecting';
  if (log.action === 'scroll') return 'scrolling';
  if (['copy', 'paste', 'cut'].includes(log.action)) return 'clipboard';
  if (['click', 'double_click', 'right_click', 'middle_click'].includes(log.action)) return 'clicking';
  if (['hover_start', 'hover_end'].includes(log.action)) return 'hovering';
  if (log.action === 'cursor_move') return 'cursor';
  if (['composer_interaction', 'message_action', 'form_submit', 'button_click'].includes(log.action)) return 'ui_interaction';
  if (['input_focus', 'input_blur'].includes(log.action)) return 'focus';
  if (log.action === 'selection_clear') return 'selection_clear';
  return 'other';
}

function sameTarget(a: NormalizedLog, b: NormalizedLog): boolean {
  return a.target_section === b.target_section && a.target_element === b.target_element;
}

function shouldGroup(current: NormalizedLog, previous: NormalizedLog): boolean {
  const gap = current.absoluteTimestamp - previous.absoluteTimestamp;
  if (gap > 60_000) return false;
  const textCategories = new Set<ActionCategory>(['typing', 'deleting']);
  if (textCategories.has(current.category) && textCategories.has(previous.category) && gap < 1_000 && sameTarget(current, previous)) return true;
  const navigation = new Set<ActionCategory>(['cursor', 'hovering', 'clicking', 'focus']);
  if (navigation.has(current.category) && navigation.has(previous.category) && gap < 1_000) return true;
  if (current.category === 'hovering' && previous.category === 'hovering' && gap < 1_500) return true;
  if (((current.category === 'hovering' && previous.category === 'cursor') || (current.category === 'cursor' && previous.category === 'hovering')) && gap < 1_500) return true;
  if (current.category === previous.category && new Set<ActionCategory>(['typing', 'deleting', 'selecting', 'clipboard']).has(current.category) && gap < 2_000) return current.category === 'typing' || current.category === 'deleting' ? current.target_section === previous.target_section : true;
  if ((current.category === 'cursor' && new Set<ActionCategory>(['typing', 'selecting', 'scrolling']).has(previous.category)) || (previous.category === 'cursor' && new Set<ActionCategory>(['typing', 'selecting', 'scrolling']).has(current.category))) return gap < 1_000;
  if (((current.category === 'scrolling' && previous.category === 'hovering') || (current.category === 'hovering' && previous.category === 'scrolling')) && gap < 1_000) return true;
  if (current.category === 'scrolling' && previous.category === 'scrolling' && gap < 5_000 && current.target_section === previous.target_section) return text(current.metadataObject.scrollDirection) === text(previous.metadataObject.scrollDirection);
  return current.category === 'ui_interaction' && previous.category === 'typing' && gap < 2_000;
}

function mostCommonCategory(logs: NormalizedLog[]): ActionCategory {
  const counts = new Map<ActionCategory, number>();
  for (const log of logs) counts.set(log.category, (counts.get(log.category) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
}

function groupLogs(logs: NormalizedLog[]): Behavior[] {
  if (logs.length === 0) return [];
  const groups: NormalizedLog[][] = [[logs[0]]];
  for (const log of logs.slice(1)) {
    const group = groups[groups.length - 1];
    if (shouldGroup(log, group[group.length - 1])) group.push(log);
    else groups.push([log]);
  }

  // Keep the offline post-processing behavior for adjacent text editing groups.
  const merged: NormalizedLog[][] = [];
  for (const group of groups) {
    const previous = merged[merged.length - 1];
    const groupCategory = mostCommonCategory(group);
    const previousCategory = previous ? mostCommonCategory(previous) : null;
    const editable = new Set<ActionCategory>(['typing', 'deleting', 'key_press']);
    if (previous && editable.has(groupCategory) && previousCategory && editable.has(previousCategory) && group[0].absoluteTimestamp - previous[previous.length - 1].absoluteTimestamp <= 1_000 && sameTarget(group[0], previous[0])) previous.push(...group);
    else merged.push(group);
  }

  return merged.map((group) => ({
    logs: group,
    category: mostCommonCategory(group),
    timestampStart: group[0].absoluteTimestamp,
    timestampEnd: group[group.length - 1].absoluteTimestamp,
    narration: null,
    mergedSpeech: '',
  }));
}

function sectionFor(log: NormalizedLog): string {
  return log.target_section || 'unknown';
}

function elementFor(log: NormalizedLog): string {
  return log.target_element || 'text field';
}

function shouldInclude(log: NormalizedLog): boolean {
  if (['cursor_move', 'selection_clear', 'keyboard_shortcut', 'second_ai_suggestion_presented', 'second_ai_suggestion_inserted', 'ai_guidance_presented', 'ai_guidance_viewed', 'ai_guidance_inserted', 'ai_guidance_ignored', 'ai_guidance_expired', 'ai_guidance_replaced'].includes(log.action)) return false;
  // Keep only response-reading scroll/hover evidence. General navigation noise
  // remains excluded from the Evaluation Agent partition.
  if (log.action === 'scroll') return log.target_section === 'response';
  if (log.category === 'hovering') return log.metadataObject.viewedAiResponse === true || Boolean(log.metadataObject.messageId) || /data-testid=/.test(log.target_element || '');
  return true;
}

function narrateText(logs: NormalizedLog[], includeKeys = false): string {
  const parts: string[] = [];
  let typed = '';
  let deleted = '';
  const flushTyped = () => { if (typed) { parts.push(`typed '${typed}'`); typed = ''; } };
  const flushDeleted = () => { if (deleted) { parts.push(`deleted '${deleted}'`); deleted = ''; } };
  for (const log of logs) {
    if (log.action === 'text_insert') { flushDeleted(); typed += text(log.metadataObject.insertedText); }
    else if (log.action === 'text_delete') { flushTyped(); deleted += text(log.metadataObject.deletedText); }
    else if (includeKeys && log.category === 'key_press' && text(log.metadataObject.key) !== 'CapsLock') { flushTyped(); flushDeleted(); parts.push(`pressed '${text(log.metadataObject.key)}'`); }
  }
  flushTyped(); flushDeleted();
  const first = logs[0];
  const action = parts.length > 5 ? parts.filter((part) => part.startsWith('typed ')).pop() || parts.join(', ') : parts.join(', ');
  return normalizeUiReferences(action ? `User ${action} in ${elementFor(first)} (${sectionFor(first)} section)` : `User interacted with ${elementFor(first)} (${sectionFor(first)} section)`);
}

function narrateClipboard(logs: NormalizedLog[]): string {
  const copiedFromResponse = logs.find((log) => log.action === 'copy' && log.target_section === 'response');
  const pastedIntoWriting = logs.find((log) => log.action === 'paste' && log.target_section === 'writing');
  if (copiedFromResponse && pastedIntoWriting) {
    const content = copiedFromResponse.text_content || '';
    const count = Number(copiedFromResponse.metadataObject.textLength) || content.length;
    return `User copied ${count} character(s) from AI response${copiedFromResponse.metadataObject.messageId != null ? ` (Message ID: ${copiedFromResponse.metadataObject.messageId})` : ''} and pasted it into writing section`;
  }
  const first = logs[0];
  const action = first.action;
  const content = first.text_content || '';
  const count = Number(first.metadataObject.textLength) || content.length;
  const verb = action === 'copy' ? 'copied' : action === 'paste' ? 'pasted' : 'cut';
  const preposition = action === 'paste' ? 'into' : 'from';
  const messageId = first.metadataObject.messageId;
  const source = `${sectionFor(first)} section${messageId != null && sectionFor(first) === 'response' ? ` (messageID: ${messageId})` : ''}`;
  return `User ${verb} ${count} character(s) ${preposition} ${source}${content ? `: '${content}'` : ''}`;
}

function narrateHover(logs: NormalizedLog[]): string | null {
  const details = [...new Set(logs.map((log) => {
    const messageId = log.metadataObject.messageId;
    if (log.metadataObject.viewedAiResponse === true) {
      return `viewed AI response${messageId != null ? ` (Message ID: ${messageId})` : ''}`;
    }
    const element = log.target_element || 'element';
    return messageId != null ? `hovered over ${element} (Message ID: ${messageId})` : `hovered over ${element}`;
  }))];
  return details.length ? `User ${details.join(', ')}` : null;
}

function narrateUi(logs: NormalizedLog[]): string {
  const first = logs[0];
  if (logs.some((log) => log.action === 'composer_interaction')) {
    const textLogs = logs.filter((log) => ['text_insert', 'text_delete'].includes(log.action));
    // A Send click may arrive in a later interaction-log batch than the
    // preceding keystrokes. It is still a valid standalone UI event.
    if (textLogs.length === 0) return 'User sent a message in prompting box';
    const typed = narrateText(textLogs);
    return typed.includes('User ') ? `${typed.replace(/ in .*$/, '')} in prompting box and sent the message` : 'User sent a message in prompting box';
  }
  if (first.action === 'message_action') return `User performed '${text(first.metadataObject.actionType) || 'unknown'}' action on message${first.metadataObject.messageId != null ? ` (Message ID: ${first.metadataObject.messageId})` : ''}`;
  if (first.action === 'form_submit') return `User submitted final work (Word count: ${Number(first.metadataObject.wordCount) || 0}, Character count: ${Number(first.metadataObject.charCount) || 0})`;
  return `User interacted with ${elementFor(first)} in ${sectionFor(first)} section`;
}

function narrateBehavior(behavior: Behavior): string | null {
  const logs = behavior.logs.filter(shouldInclude);
  if (logs.length === 0) return null;
  const categories = new Set(logs.map((log) => log.category));
  const first = logs[0];
  if (categories.has('typing') || categories.has('deleting')) return narrateText(logs, categories.has('key_press'));
  if (behavior.category === 'clipboard') return narrateClipboard(logs);
  if (behavior.category === 'hovering') return narrateHover(logs);
  if (behavior.category === 'scrolling') {
    const direction = text(first.metadataObject.scrollDirection);
    return `User read AI response by scrolling${direction && direction !== 'none' ? ` ${direction}` : ''} in response section`;
  }
  if (behavior.category === 'selecting') {
    const selected = text(first.metadataObject.selectedText);
    const count = Number(first.metadataObject.textLength) || selected.length;
    return `User selected ${count} character(s) in ${sectionFor(first)} section${first.metadataObject.messageId != null ? ` (Message ID: ${first.metadataObject.messageId})` : ''}${selected ? `: '${selected}'` : ''}`;
  }
  if (behavior.category === 'ui_interaction') return narrateUi(logs);
  if (behavior.category === 'key_press') return text(first.metadataObject.key) === 'CapsLock' ? null : normalizeUiReferences(`User pressed '${text(first.metadataObject.key) || 'Unknown'}' key in ${elementFor(first)} (${sectionFor(first)} section)`);
  if (behavior.category === 'clicking') return logs.length === 1 ? `User clicked on ${elementFor(first)} in ${sectionFor(first)} section` : `User clicked ${logs.length} times on ${elementFor(first)} in ${sectionFor(first)} section`;
  if (behavior.category === 'focus') return `User ${first.action === 'input_focus' ? 'focused on' : 'unfocused from'} ${sectionFor(first)} section`;
  return `User performed ${first.action} in ${sectionFor(first)} section`;
}

function eventSort(a: Omit<TimelineEvent, 'eventId'>, b: Omit<TimelineEvent, 'eventId'>): number {
  if (a.timestampStart !== b.timestampStart) return a.timestampStart - b.timestampStart;
  const rank: Record<EventType, number> = { user_action: 0, user_speech: 1, user_message: 2, ai_response: 3 };
  return rank[a.eventType] - rank[b.eventType];
}

async function sessionClock(db: SqlExecutor, sessionId: string): Promise<SessionClock> {
  sessionMetadataDiagnostic({
    stage: 'timeline_session_clock_read_before',
    sessionId,
    metadata: await inspectSessionMetadata(db, sessionId),
  });
  let rows: unknown;
  try {
    [rows] = await db.execute('SELECT started_at, created_at, metadata FROM sessions WHERE id = ?', [sessionId]);
  } catch (error) {
    sessionMetadataDiagnostic({
      stage: 'timeline_session_clock_read_failed',
      sessionId,
      metadata: await inspectSessionMetadata(db, sessionId),
      error: error instanceof Error ? { name: error.name, message: error.message } : { value: String(error) },
    });
    throw error;
  }
  const session = (rows as any[])[0];
  if (!session) throw new Error(`Session ${sessionId} was not found while building its timeline`);
  const metadata = parseObject(session.metadata);
  const clientStart = Number(metadata.sessionStartEpochMs);
  const recordingStart = Number(metadata.recordingStartEpochMs);
  sessionMetadataDiagnostic({
    stage: 'timeline_session_clock_read_after',
    sessionId,
    decodedSessionStartEpochMs: Number.isFinite(clientStart) && clientStart > 0 ? clientStart : null,
    decodedRecordingStartEpochMs: Number.isFinite(recordingStart) && recordingStart > 0 ? recordingStart : null,
  });
  if (Number.isFinite(clientStart) && clientStart > 0) {
    return {
      sessionStartEpochMs: clientStart,
      recordingStartEpochMs: Number.isFinite(recordingStart) && recordingStart > 0 ? recordingStart : null,
    };
  }
  const fallback = new Date(session.started_at || session.created_at).getTime();
  if (!Number.isFinite(fallback)) throw new Error(`Session ${sessionId} has no usable start timestamp`);
  return {
    sessionStartEpochMs: fallback,
    recordingStartEpochMs: Number.isFinite(recordingStart) && recordingStart > 0 ? recordingStart : null,
  };
}

function toEpochSpeechTimestamp(value: unknown, clock: SessionClock): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return clock.sessionStartEpochMs;
  // Current clients persist epoch milliseconds. Retain a safe conversion path
  // for any older relative-time rows, anchoring them to recording start (not
  // session start) because microphone capture may begin later than the page.
  if (numeric >= 100_000_000_000) return numeric;
  return (clock.recordingStartEpochMs ?? clock.sessionStartEpochMs) + numeric;
}

function eventFromRow(row: any): TimelineEvent {
  return {
    eventId: Number(row.event_id),
    timestampStart: Number(row.timestamp_start),
    timestampEnd: Number(row.timestamp_end),
    eventType: row.event_type as EventType,
    actionDescription: text(row.action_description),
    speech: text(row.speech),
    userMessage: text(row.user_message),
    aiResponse: text(row.ai_response),
  };
}

async function loadMaterializedEvents(db: SqlExecutor, sessionId: string): Promise<TimelineEvent[]> {
  const [rows] = await db.execute(
    `SELECT event_id, timestamp_start, timestamp_end, event_type, action_description, speech, user_message, ai_response
     FROM session_events WHERE session_id = ? ORDER BY event_id ASC`,
    [sessionId]
  );
  return (rows as any[]).map(eventFromRow);
}

/**
 * Initialise the raw-source watermarks for a pre-existing timeline. This is a
 * one-time compatibility guard: it prevents a deployed incremental reader from
 * replaying historical source rows into an already-evaluated session. New
 * sessions receive zero cursors and are materialised entirely incrementally.
 */
async function sourceCursors(db: SqlExecutor, sessionId: string): Promise<Map<TimelineSource, number>> {
  const sources: TimelineSource[] = ['interaction_logs', 'speech_segments', 'messages'];
  const [cursorRows] = await db.execute(
    'SELECT source_name, last_source_id FROM timeline_source_cursors WHERE session_id = ?',
    [sessionId]
  );
  const existing = new Map<TimelineSource, number>((cursorRows as any[]).map((row) => [row.source_name as TimelineSource, Number(row.last_source_id)]));
  if (existing.size === sources.length) return existing;

  const [eventRows] = await db.execute('SELECT COUNT(*) AS count FROM session_events WHERE session_id = ?', [sessionId]);
  const hasLegacyTimeline = Number((eventRows as any[])[0]?.count ?? 0) > 0;
  for (const source of sources) {
    if (existing.has(source)) continue;
    let watermark = 0;
    if (hasLegacyTimeline) {
      const table = source;
      const [maxRows] = await db.execute(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table} WHERE session_id = ?`, [sessionId]);
      watermark = Number((maxRows as any[])[0]?.max_id ?? 0);
    }
    await db.execute(
      `INSERT INTO timeline_source_cursors (session_id, source_name, last_source_id)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE last_source_id = last_source_id`,
      [sessionId, source, watermark]
    );
    existing.set(source, watermark);
  }
  return existing;
}

function mergeSpeechSegments(segments: Array<{ timestampStart: number; timestampEnd: number; transcription: string }>) {
  const merged: Array<{ timestampStart: number; timestampEnd: number; transcription: string }> = [];
  for (const segment of segments.sort((a, b) => a.timestampStart - b.timestampStart || a.timestampEnd - b.timestampEnd)) {
    const previous = merged[merged.length - 1];
    // Realtime VAD can split one continuous utterance at a transport boundary.
    // Merge only an essentially adjacent pair: a 500ms-or-shorter gap is the
    // timestamp gap between the prior chunk's end and this chunk's start, not
    // the browser's separate local-VAD commit setting.
    if (previous && segment.timestampStart - previous.timestampEnd <= 500) {
      previous.timestampEnd = Math.max(previous.timestampEnd, segment.timestampEnd);
      previous.transcription = `${previous.transcription} ${segment.transcription}`.replace(/\s+/g, ' ').trim();
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

/**
 * The pure preprocessing core shared by the live MySQL materializer and the
 * file-based verification notebook. Callers are responsible for supplying
 * only source rows after their durable source cursors; this function applies
 * the same normalisation, narration, timestamp alignment, and event ordering
 * used in production.
 */
export interface TimelineRowsInput {
  sessionStartEpochMs: number;
  recordingStartEpochMs?: number | null;
  interactionLogs: InteractionLog[];
  speechSegments: Array<{ id: number; timestamp_start: number; timestamp_end: number; transcription: string | null }>;
  messages: Array<{ id: number; role: 'user' | 'assistant'; content: string; is_guidance?: boolean | number; timestamp: string | Date }>;
  // Context only: this row was already consumed by the message source cursor
  // and is never emitted again. It lets a newly-arrived assistant response keep
  // the conventional +1s placement after its preceding user message.
  previousUserMessageTimestamp?: string | Date | null;
  nextEventId?: number;
}

export function buildTimelineEventsFromRows(input: TimelineRowsInput): TimelineEvent[] {
  const clock: SessionClock = {
    sessionStartEpochMs: input.sessionStartEpochMs,
    recordingStartEpochMs: input.recordingStartEpochMs ?? null,
  };
  const rawLogs = input.interactionLogs;
  const normalized = rawLogs
    .filter((log) => !(log.action === 'hover_start' && log.target_element === '#root'))
    .filter((log) => log.action !== 'selection_clear')
    .map((log) => {
      const metadata = parseObject(log.metadata);
      return { ...log, absoluteTimestamp: clock.sessionStartEpochMs + Number(log.timestamp), metadataObject: metadata, category: categoryFor(log, metadata) };
    })
    .filter((log) => !(log.action === 'key_press' && text(log.metadataObject.key) === 'CapsLock'))
    .filter((log, index, all) => {
      const previous = all[index - 1];
      return !(previous && previous.action === 'paste' && log.action === 'text_insert' && log.absoluteTimestamp - previous.absoluteTimestamp < 100 && (previous.text_content || '') === text(log.metadataObject.insertedText));
    });

  const behaviors = groupLogs(normalized);
  for (const behavior of behaviors) behavior.narration = narrateBehavior(behavior);

  const unmergedSpeech: Array<{ timestampStart: number; timestampEnd: number; transcription: string }> = [];
  for (const row of input.speechSegments) {
    const transcription = text(row.transcription).trim();
    if (FILLER_TRANSCRIPTS.has(normalizeFillerCandidate(transcription))) continue;
    const timestampStart = toEpochSpeechTimestamp(row.timestamp_start, clock);
    const timestampEnd = toEpochSpeechTimestamp(row.timestamp_end, clock);
    const target = behaviors.find((behavior) => behavior.narration && behavior.timestampStart <= timestampStart && timestampEnd <= behavior.timestampEnd);
    if (target) target.mergedSpeech = `${target.mergedSpeech} ${transcription}`.trim();
    else unmergedSpeech.push({ timestampStart, timestampEnd, transcription });
  }

  const pending: Omit<TimelineEvent, 'eventId'>[] = [];
  for (const behavior of behaviors) {
    if (!behavior.narration || behavior.narration.toLowerCase().includes('unknown section')) continue;
    pending.push({ timestampStart: behavior.timestampStart, timestampEnd: behavior.timestampEnd, eventType: 'user_action', actionDescription: normalizeUiReferences(behavior.narration), speech: behavior.mergedSpeech, userMessage: '', aiResponse: '' });
  }
  for (const speech of mergeSpeechSegments(unmergedSpeech)) pending.push({ timestampStart: speech.timestampStart, timestampEnd: speech.timestampEnd, eventType: 'user_speech', actionDescription: '', speech: speech.transcription, userMessage: '', aiResponse: '' });
  let precedingUserTimestamp = input.previousUserMessageTimestamp == null
    ? null
    : new Date(input.previousUserMessageTimestamp).getTime();
  if (!Number.isFinite(precedingUserTimestamp)) precedingUserTimestamp = null;
  for (const row of input.messages) {
    if (row.is_guidance) continue;
    const sourceTimestamp = new Date(row.timestamp).getTime();
    if (!Number.isFinite(sourceTimestamp)) continue;
    if (row.role === 'user') {
      precedingUserTimestamp = sourceTimestamp;
      pending.push({ timestampStart: sourceTimestamp, timestampEnd: sourceTimestamp, eventType: 'user_message', actionDescription: '', speech: '', userMessage: text(row.content), aiResponse: '' });
      continue;
    }
    // This is a presentation timestamp applied after source-row selection.
    // It must not affect source cursor movement or which rows are evaluated.
    const timelineTimestamp = precedingUserTimestamp == null ? sourceTimestamp + 1_000 : precedingUserTimestamp + 1_000;
    pending.push({ timestampStart: timelineTimestamp, timestampEnd: timelineTimestamp, eventType: 'ai_response', actionDescription: '', speech: '', userMessage: '', aiResponse: text(row.content) });
  }

  let nextEventId = input.nextEventId ?? 1;
  return pending.sort(eventSort).map((event) => ({ ...event, eventId: nextEventId++ }));
}

/** Serialize incremental materialisations so concurrent source uploads cannot race. */
export async function buildSessionTimeline(db: mysql.Pool, sessionId: string, diagnostics: TimelineDiagnostics = {}): Promise<TimelineEvent[]> {
  const traceId = diagnostics.traceId ?? `timeline-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const diagnosticContext = { ...diagnostics, traceId };
  const previous = activeBuilds.get(sessionId);
  timelineDiagnostic({ ...diagnosticContext, sessionId, stage: previous ? 'queued_after_active_build' : 'build_requested' });
  const current = (previous ? previous.catch(() => []) : Promise.resolve([])).then(() => materializeTimelineDelta(db, sessionId, diagnosticContext));
  activeBuilds.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (activeBuilds.get(sessionId) === current) activeBuilds.delete(sessionId);
  }
}

/**
 * Read only the unconsumed rows from each raw source, turn that delta into
 * canonical events, and advance the three durable source watermarks together.
 * The Evaluation Agent has a separate last_evaluated_event_id cursor; it never
 * doubles as a raw-data ingestion cursor.
 */
async function materializeTimelineDelta(db: mysql.Pool, sessionId: string, diagnostics: TimelineDiagnostics): Promise<TimelineEvent[]> {
  let connection: mysql.PoolConnection | null = null;
  let stage = 'acquire_connection';
  try {
    connection = await db.getConnection();
    timelineDiagnostic({ ...diagnostics, sessionId, stage, connectionThreadId: connection.threadId });
    stage = 'begin_transaction';
    await connection.beginTransaction();
    stage = 'materialize_delta';
    const events = await materializeTimelineDeltaOnce(connection, sessionId, diagnostics);
    stage = 'commit';
    await connection.commit();
    timelineDiagnostic({ ...diagnostics, sessionId, stage: 'committed', connectionThreadId: connection.threadId, eventCount: events.length });
    return events;
  } catch (originalError) {
    timelineDiagnostic({ ...diagnostics, sessionId, stage: `${stage}:primary_error`, connectionThreadId: connection?.threadId, error: errorSummary(originalError) });
    if (connection) {
      try {
        await connection.rollback();
        timelineDiagnostic({ ...diagnostics, sessionId, stage: `${stage}:rollback_succeeded`, connectionThreadId: connection.threadId });
      } catch (rollbackError) {
        // Preserve originalError for the caller; this rollback failure is secondary.
        timelineDiagnostic({ ...diagnostics, sessionId, stage: `${stage}:rollback_failed`, connectionThreadId: connection.threadId, error: errorSummary(rollbackError) });
      }
    }
    throw originalError;
  } finally {
    if (connection) connection.release();
  }
}

async function materializeTimelineDeltaOnce(db: SqlExecutor, sessionId: string, diagnostics: TimelineDiagnostics): Promise<TimelineEvent[]> {
  timelineDiagnostic({ ...diagnostics, sessionId, stage: 'load_session_clock' });
  const clock = await sessionClock(db, sessionId);
  timelineDiagnostic({ ...diagnostics, sessionId, stage: 'load_source_cursors' });
  const cursors = await sourceCursors(db, sessionId);
  const messageCursor = cursors.get('messages') ?? 0;
  timelineDiagnostic({
    ...diagnostics,
    sessionId,
    stage: 'fetch_source_deltas',
    sourceCursors: Object.fromEntries(cursors),
  });
  const [logRows, speechRows, messageRows, priorUserRows] = await Promise.all([
    db.execute('SELECT id, event_type, action, target_element, target_section, text_content, metadata, timestamp FROM interaction_logs WHERE session_id = ? AND id > ? ORDER BY id ASC', [sessionId, cursors.get('interaction_logs') ?? 0]),
    db.execute('SELECT id, timestamp_start, timestamp_end, transcription FROM speech_segments WHERE session_id = ? AND id > ? ORDER BY id ASC', [sessionId, cursors.get('speech_segments') ?? 0]),
    db.execute('SELECT id, role, content, is_guidance, timestamp FROM messages WHERE session_id = ? AND id > ? ORDER BY id ASC', [sessionId, messageCursor]),
    messageCursor > 0
      ? db.execute("SELECT timestamp FROM messages WHERE session_id = ? AND role = 'user' AND id <= ? ORDER BY id DESC LIMIT 1", [sessionId, messageCursor])
      : Promise.resolve([[]]),
  ]);

  timelineDiagnostic({
    ...diagnostics,
    sessionId,
    stage: 'source_deltas_loaded',
    sourceRowCounts: { interaction_logs: (logRows[0] as any[]).length, speech_segments: (speechRows[0] as any[]).length, messages: (messageRows[0] as any[]).length },
  });

  timelineDiagnostic({ ...diagnostics, sessionId, stage: 'load_event_watermark' });
  const [maxRows] = await db.execute('SELECT COALESCE(MAX(event_id), 0) AS max_event_id FROM session_events WHERE session_id = ?', [sessionId]);
  const events = buildTimelineEventsFromRows({
    sessionStartEpochMs: clock.sessionStartEpochMs,
    recordingStartEpochMs: clock.recordingStartEpochMs,
    interactionLogs: logRows[0] as InteractionLog[],
    speechSegments: speechRows[0] as any[],
    messages: messageRows[0] as any[],
    previousUserMessageTimestamp: (priorUserRows[0] as any[])[0]?.timestamp ?? null,
    nextEventId: Number((maxRows as any[])[0]?.max_event_id ?? 0) + 1,
  });
  timelineDiagnostic({ ...diagnostics, sessionId, stage: 'insert_timeline_events', generatedEventCount: events.length });
  for (const event of events) {
    await db.execute(
      `INSERT INTO session_events (session_id, event_id, timestamp_start, timestamp_end, event_type, action_description, speech, user_message, ai_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, event.eventId, event.timestampStart, event.timestampEnd, event.eventType, event.actionDescription || null, event.speech || null, event.userMessage || null, event.aiResponse || null]
    );
  }
  const sourceMaxima: Array<[TimelineSource, any[]]> = [
    ['interaction_logs', logRows[0] as any[]],
    ['speech_segments', speechRows[0] as any[]],
    ['messages', messageRows[0] as any[]],
  ];
  timelineDiagnostic({ ...diagnostics, sessionId, stage: 'advance_source_cursors' });
  for (const [source, rows] of sourceMaxima) {
    const lastId = rows.length ? Number(rows[rows.length - 1].id) : null;
    if (lastId !== null) {
      await db.execute(
        `UPDATE timeline_source_cursors
         SET last_source_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE session_id = ? AND source_name = ?`,
        [lastId, sessionId, source]
      );
    }
  }
  return loadMaterializedEvents(db, sessionId);
}

export function partitionEndingAtLatestUserMessage(events: TimelineEvent[]): TimelineEvent[] {
  let latestIndex = -1;
  let previousUserIndex = -1;
  events.forEach((event, index) => {
    if (event.userMessage.trim()) {
      previousUserIndex = latestIndex;
      latestIndex = index;
    }
  });
  if (latestIndex === -1) return [];
  return events.slice(previousUserIndex + 1, latestIndex + 1);
}

export function unevaluatedTail(events: TimelineEvent[], lastEvaluatedEventId: number): TimelineEvent[] {
  return events.filter((event) => event.eventId > lastEvaluatedEventId);
}
