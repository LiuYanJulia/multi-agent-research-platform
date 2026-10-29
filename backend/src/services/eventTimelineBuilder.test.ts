import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTimelineEventsFromRows } from './eventTimelineBuilder';

const guidanceLog = (overrides: Record<string, unknown>) => ({
  id: 1,
  event_type: 'mouse',
  action: 'hover_start',
  target_element: 'guidance-card',
  target_section: 'guidance',
  text_content: null,
  metadata: JSON.stringify({ messageId: 7 }),
  timestamp: 1_000,
  ...overrides,
});

test('maps guidance engagement to response evidence only in evaluator timeline input', () => {
  const events = buildTimelineEventsFromRows({
    sessionStartEpochMs: 0,
    interactionLogs: [
      guidanceLog({ action: 'hover_start', timestamp: 1_000 }),
      guidanceLog({ action: 'text_select', timestamp: 4_000, metadata: JSON.stringify({ messageId: 7, selectedText: 'Neighbourhood heat check-ins', textLength: 28 }) }),
      guidanceLog({ action: 'scroll', timestamp: 7_000, metadata: JSON.stringify({ messageId: 7, scrollDirection: 'down' }) }),
      guidanceLog({ action: 'copy', timestamp: 10_000, text_content: 'Neighbourhood heat check-ins', metadata: JSON.stringify({ messageId: 7, textLength: 28 }) }),
      { ...guidanceLog({ id: 2, action: 'paste', target_section: 'writing', timestamp: 10_500, text_content: 'Neighbourhood heat check-ins', metadata: JSON.stringify({ textLength: 28 }) }) },
    ],
    speechSegments: [],
    messages: [],
  });

  const descriptions = events.map((event) => event.actionDescription);
  assert.ok(descriptions.some((description) => description.includes('hovered over guidance-card (Message ID: 7)')));
  assert.ok(descriptions.some((description) => description.includes('selected 28 character(s) (response section) (Message ID: 7)')));
  assert.ok(descriptions.some((description) => description.includes('read AI response by scrolling down (response section)')));
  assert.ok(descriptions.some((description) => description.includes('copied 28 character(s) from AI response (Message ID: 7) and pasted it into writing section')));
  assert.ok(descriptions.every((description) => !description.includes('guidance section')));
});

test('emits an ai_guidance chat-history row as an AI response for offline parity processing', () => {
  const events = buildTimelineEventsFromRows({
    sessionStartEpochMs: 0,
    interactionLogs: [],
    speechSegments: [],
    messages: [{
      id: 7,
      role: 'ai_guidance',
      content: 'Offer pharmacy partners a heat-check-in role.',
      guidance_display_summary: '[Synthesis] One connection idea.',
      timestamp: '2026-10-30T00:00:00.000Z',
    }],
  });

  assert.deepEqual(events.map((event) => ({ eventType: event.eventType, aiResponse: event.aiResponse })), [{
    eventType: 'ai_response',
    aiResponse: '[Synthesis] One connection idea.\n\nOffer pharmacy partners a heat-check-in role.',
  }]);
});
