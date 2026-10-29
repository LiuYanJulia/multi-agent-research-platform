import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuidanceConversationContext,
  guidanceGenerationEligible,
  GUIDANCE_GENERATION_MIN_ELAPSED_SECONDS,
  MAIN_RESPONSE_SYSTEM_PROMPT,
} from './chat';

test('ends the actual-task main response prompt with an explicit concise-response instruction', () => {
  assert.match(MAIN_RESPONSE_SYSTEM_PROMPT, /Keep the response concise\.$/);
});

test('puts old guidance in explicit memory rather than the assistant conversation history', () => {
  const context = buildGuidanceConversationContext([
    { role: 'user', content: 'How could transport help?' },
    { role: 'assistant', content: 'A normal chat answer.' },
    { role: 'ai_guidance', content: 'An already delivered transport voucher idea.' },
  ]);

  assert.deepEqual(context.conversation, [
    { role: 'user', content: 'How could transport help?' },
    { role: 'assistant', content: 'A normal chat answer.' },
  ]);
  assert.deepEqual(context.guidanceMemory, ['An already delivered transport voucher idea.']);
});

test('only starts guidance generation after 100 seconds since the last displayed guidance', () => {
  assert.equal(GUIDANCE_GENERATION_MIN_ELAPSED_SECONDS, 100);
  assert.equal(guidanceGenerationEligible(99_999), false);
  assert.equal(guidanceGenerationEligible(100_001), true);
});
