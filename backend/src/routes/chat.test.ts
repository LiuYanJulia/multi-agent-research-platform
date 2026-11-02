import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuidanceConversationContext,
  buildFinalGuidanceInstruction,
  guidanceGenerationEligible,
  GUIDANCE_GENERATION_MIN_ELAPSED_SECONDS,
  GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT,
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

test('final guidance input always includes direction and ideas but conditionally includes writing and earlier suggestions', () => {
  const full = buildFinalGuidanceInstruction({
    directionGuidance: 'Develop a new coordination mechanism.',
    previousIdeas: ['Cooling hubs.', 'Neighbour check-ins.'],
    writingContextSummary: 'The draft already includes transport vouchers.',
  }, ['Earlier guidance proposed mobile cooling buses.'], 80, 'C');
  assert.match(full, /^Direction:/);
  assert.match(full, /Earlier participant ideas:/);
  assert.match(full, /Existing writing:/);
  assert.match(full, /Earlier suggestions:/);
  assert.match(full, /If Existing writing is provided above/i);
  assert.match(full, /Stay within 80 English words/i);

  const withoutOptionalMemory = buildFinalGuidanceInstruction({
    directionGuidance: 'Develop two nearby refinements.', previousIdeas: ['Heat alerts.'],
  }, [], 50, 'D');
  assert.doesNotMatch(withoutOptionalMemory, /Existing writing:/);
  assert.doesNotMatch(withoutOptionalMemory, /Earlier suggestions:/);
  assert.match(withoutOptionalMemory, /For divergent guidance, use a numbered list/i);
});

test('guidance system prompt explains the design task and optional avoidance material', () => {
  assert.match(GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT, /creative and useful policy or service design/i);
  assert.match(GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT, /based on the given Direction and Earlier participant ideas/i);
  assert.match(GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT, /When Existing writing is provided/i);
  assert.match(GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT, /When Earlier suggestions are provided/i);
});
