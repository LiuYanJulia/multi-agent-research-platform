/**
 * Builds the online equivalent of the offline behavior_narration.py +
 * design_move_separation.py pipeline. All output timestamps are epoch
 * milliseconds so interaction logs and realtime speech can be merged safely.
 */
import mysql from 'mysql2/promise';

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

function normalizeTranscript(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
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
  if (['cursor_move', 'selection_clear', 'keyboard_shortcut', 'second_ai_suggestion_presented', 'second_ai_suggestion_inserted', 'ai_guidance_presented', 'ai_guidance_inserted', 'ai_guidance_expired', 'ai_guidance_replaced'].includes(log.action)) return false;
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
    const typed = narrateText(logs.filter((log) => ['text_insert', 'text_delete'].includes(log.action)));
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

async function sessionStartEpoch(db: mysql.Pool, sessionId: string): Promise<number> {
  const [rows] = await db.execute('SELECT started_at, created_at, metadata FROM sessions WHERE id = ?', [sessionId]);
  const session = (rows as any[])[0];
  if (!session) throw new Error(`Session ${sessionId} was not found while building its timeline`);
  const metadata = parseObject(session.metadata);
  const clientStart = Number(metadata.sessionStartEpochMs);
  if (Number.isFinite(clientStart) && clientStart > 0) return clientStart;
  const fallback = new Date(session.started_at || session.created_at).getTime();
  if (!Number.isFinite(fallback)) throw new Error(`Session ${sessionId} has no usable start timestamp`);
  return fallback;
}

/** Serialize rebuilds per session so concurrent log, speech, and chat requests cannot overwrite a newer snapshot. */
export async function buildSessionTimeline(db: mysql.Pool, sessionId: string): Promise<TimelineEvent[]> {
  const previous = activeBuilds.get(sessionId);
  const current = (previous ? previous.catch(() => []) : Promise.resolve([])).then(() => rebuildSessionTimeline(db, sessionId));
  activeBuilds.set(sessionId, current);
  try {
    return await current;
  } finally {
    if (activeBuilds.get(sessionId) === current) activeBuilds.delete(sessionId);
  }
}

/** Rebuild the canonical event sequence from all currently persisted raw sources. */
async function rebuildSessionTimeline(db: mysql.Pool, sessionId: string): Promise<TimelineEvent[]> {
  const startEpoch = await sessionStartEpoch(db, sessionId);
  const [logRows, speechRows, messageRows] = await Promise.all([
    db.execute('SELECT id, event_type, action, target_element, target_section, text_content, metadata, timestamp FROM interaction_logs WHERE session_id = ? ORDER BY timestamp ASC, id ASC', [sessionId]),
    db.execute('SELECT timestamp_start, timestamp_end, transcription FROM speech_segments WHERE session_id = ? ORDER BY timestamp_start ASC, id ASC', [sessionId]),
    db.execute('SELECT id, role, content, is_guidance, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC, id ASC', [sessionId]),
  ]);

  const rawLogs = logRows[0] as InteractionLog[];
  const normalized = rawLogs
    .filter((log) => !(log.action === 'hover_start' && log.target_element === '#root'))
    .filter((log) => log.action !== 'selection_clear')
    .map((log) => {
      const metadata = parseObject(log.metadata);
      return { ...log, absoluteTimestamp: startEpoch + Number(log.timestamp), metadataObject: metadata, category: categoryFor(log, metadata) };
    })
    .filter((log) => !(log.action === 'key_press' && text(log.metadataObject.key) === 'CapsLock'))
    .filter((log, index, all) => {
      const previous = all[index - 1];
      return !(previous && previous.action === 'paste' && log.action === 'text_insert' && log.absoluteTimestamp - previous.absoluteTimestamp < 100 && (previous.text_content || '') === text(log.metadataObject.insertedText));
    });

  const behaviors = groupLogs(normalized);
  for (const behavior of behaviors) behavior.narration = narrateBehavior(behavior);

  const unmergedSpeech: Array<{ timestampStart: number; timestampEnd: number; transcription: string }> = [];
  for (const row of speechRows[0] as any[]) {
    const transcription = text(row.transcription).trim();
    if (FILLER_TRANSCRIPTS.has(normalizeTranscript(transcription))) continue;
    const target = behaviors.find((behavior) => behavior.narration && behavior.timestampStart <= Number(row.timestamp_start) && Number(row.timestamp_end) <= behavior.timestampEnd);
    if (target) target.mergedSpeech = `${target.mergedSpeech} ${transcription}`.trim();
    else unmergedSpeech.push({ timestampStart: Number(row.timestamp_start), timestampEnd: Number(row.timestamp_end), transcription });
  }

  const pending: Omit<TimelineEvent, 'eventId'>[] = [];
  for (const behavior of behaviors) {
    if (!behavior.narration || behavior.narration.toLowerCase().includes('unknown section')) continue;
    pending.push({ timestampStart: behavior.timestampStart, timestampEnd: behavior.timestampEnd, eventType: 'user_action', actionDescription: normalizeUiReferences(behavior.narration), speech: behavior.mergedSpeech, userMessage: '', aiResponse: '' });
  }
  for (const speech of unmergedSpeech) pending.push({ timestampStart: speech.timestampStart, timestampEnd: speech.timestampEnd, eventType: 'user_speech', actionDescription: '', speech: speech.transcription, userMessage: '', aiResponse: '' });
  for (const row of messageRows[0] as any[]) {
    if (row.is_guidance) continue;
    const timestamp = new Date(row.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    pending.push({ timestampStart: timestamp, timestampEnd: timestamp, eventType: row.role === 'assistant' ? 'ai_response' : 'user_message', actionDescription: '', speech: '', userMessage: row.role === 'user' ? text(row.content) : '', aiResponse: row.role === 'assistant' ? text(row.content) : '' });
  }

  const events = pending.sort(eventSort).map((event, index) => ({ ...event, eventId: index + 1 }));
  await db.execute('DELETE FROM session_events WHERE session_id = ?', [sessionId]);
  for (const event of events) {
    await db.execute(
      `INSERT INTO session_events (session_id, event_id, timestamp_start, timestamp_end, event_type, action_description, speech, user_message, ai_response)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sessionId, event.eventId, event.timestampStart, event.timestampEnd, event.eventType, event.actionDescription || null, event.speech || null, event.userMessage || null, event.aiResponse || null]
    );
  }
  return events;
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
