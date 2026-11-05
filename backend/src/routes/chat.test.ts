import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuidanceConversationContext,
  buildFinalGuidanceInstruction,
  guidanceGenerationEligible,
  GUIDANCE_GENERATION_MIN_ELAPSED_SECONDS,
  GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT,
  MAIN_RESPONSE_SYSTEM_PROMPT,
  guidanceResponseSystemPrompt,
  mainResponseSystemMessages,
} from './chat';

test('ends the actual-task main response prompt with an explicit concise-response instruction', () => {
  assert.match(MAIN_RESPONSE_SYSTEM_PROMPT, /Keep the response concise\.$/);
});

test('actual-task chat and guidance prompts prohibit major new cooling infrastructure', () => {
  assert.match(MAIN_RESPONSE_SYSTEM_PROMPT, /cannot build major new cooling infrastructure/i);
  assert.match(GUIDANCE_MAIN_RESPONSE_SYSTEM_PROMPT, /cannot build major new cooling infrastructure/i);
});

test('practice keeps its existing prompt behavior while actual guidance receives the new task constraint', () => {
  assert.deepEqual(mainResponseSystemMessages('practice_user_1'), []);
  assert.doesNotMatch(guidanceResponseSystemPrompt('practice_user_1'), /cannot build major new cooling infrastructure/i);
  assert.match(guidanceResponseSystemPrompt('actual_user_1'), /cannot build major new cooling infrastructure/i);
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

test('only starts guidance generation after 110 seconds since the last displayed guidance', () => {
  assert.equal(GUIDANCE_GENERATION_MIN_ELAPSED_SECONDS, 110);
  assert.equal(guidanceGenerationEligible(109_999), false);
  assert.equal(guidanceGenerationEligible(110_001), true);
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
