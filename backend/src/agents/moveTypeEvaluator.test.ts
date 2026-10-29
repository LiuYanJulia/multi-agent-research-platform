import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSubstantiveParticipantContent } from './moveTypeEvaluator';

const event = (overrides: Partial<Parameters<typeof hasSubstantiveParticipantContent>[0][number]>) => ({
  eventId: 1, timestampStart: 0, timestampEnd: 1, eventType: 'user_message' as const,
  actionDescription: '', speech: '', userMessage: '', aiResponse: '', ...overrides,
});

test('does not count pasted task text, generic UI labels, or speech fragments as substantive ideas', () => {
  assert.equal(hasSubstantiveParticipantContent([event({ userMessage: 'The system should help older adults living alone, outdoor workers, and households without reliable cooling with limited public resources.' })]), false);
  assert.equal(hasSubstantiveParticipantContent([event({ userMessage: 'Audio recording active' })]), false);
  assert.equal(hasSubstantiveParticipantContent([event({ eventType: 'user_speech', speech: 'cooling hubs' })]), false);
});

test('keeps a participant-authored design proposal as substantive content', () => {
  assert.equal(hasSubstantiveParticipantContent([event({ userMessage: 'Partner pharmacies could issue heat-risk check-ins when residents collect prescriptions.' })]), true);
});
