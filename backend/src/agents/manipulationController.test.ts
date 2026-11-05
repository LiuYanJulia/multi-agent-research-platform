import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directionPlannerSystemPrompt,
  generateSplitGuidancePlanner,
  guidanceDisplaySummary,
  guidanceResponseWordLimit,
  parseDirectionOutput,
  parseIdeaExtractorOutput,
} from './manipulationController';
import { GUIDANCE_NOTIFICATION_COOLDOWN_SECONDS } from '../services/guidanceDelivery';

test('maps every orientation and magnitude to its approved guidance response word limit', () => {
  assert.equal(guidanceResponseWordLimit('D', 'high'), 120);
  assert.equal(guidanceResponseWordLimit('D', 'low'), 50);
  assert.equal(guidanceResponseWordLimit('C', 'high'), 80);
  assert.equal(guidanceResponseWordLimit('C', 'low'), 50);
});

test('labels divergent and convergent guidance summaries before their muted copy', () => {
  const moves = [{ moveId: 1, moveType: 1, orientation: 'D' as const, description: 'Cooling hub network' }];

  assert.match(
    guidanceDisplaySummary({ targetOrientation: 'D', magnitude: 'high', selectedContextMoves: moves, requiredIdeaCount: 6 }),
    /^\[Exploration\] Based on your 1 earlier idea,/
  );
  assert.match(
    guidanceDisplaySummary({ targetOrientation: 'C', magnitude: 'low', selectedContextMoves: moves, requiredIdeaCount: null }),
    /^\[Synthesis\] Based on your 1 earlier idea,/
  );
});

test('uses one two-minute cooldown for participant-visible guidance delivery', () => {
  assert.equal(GUIDANCE_NOTIFICATION_COOLDOWN_SECONDS, 120);
});

test('idea extraction accepts grounded phrases with natural sentence punctuation', () => {
  assert.deepEqual(
    parseIdeaExtractorOutput('{"previousIdeas":["Cooling hubs offer free refuge.","Neighbour heat buddies"]}'),
    { previousIdeas: ['Cooling hubs offer free refuge.', 'Neighbour heat buddies'] },
  );
});

test('direction extraction accepts a non-empty instruction without literal contract keywords', () => {
  assert.deepEqual(
    parseDirectionOutput('{"directionGuidance":"Develop a new service handoff from the selected ideas."}'),
    { directionGuidance: 'Develop a new service handoff from the selected ideas.' },
  );
});

test('every direction condition has two few-shot examples and its required intervention shape', () => {
  const expectations = [
    [{ targetOrientation: 'D' as const, magnitude: 'high' as const }, /exactly six/i],
    [{ targetOrientation: 'D' as const, magnitude: 'low' as const }, /exactly two/i],
    [{ targetOrientation: 'C' as const, magnitude: 'high' as const }, /substantial new design direction/i],
    [{ targetOrientation: 'C' as const, magnitude: 'low' as const }, /small but substantive new connection/i],
  ] as const;
  for (const [spec, requirement] of expectations) {
    const prompt = directionPlannerSystemPrompt(spec);
    assert.match(prompt, requirement);
    assert.equal((prompt.match(/Example input:/g) ?? []).length, 2);
    assert.match(prompt, /You create one instruction prompt for a design-idea generator/i);
  }
});

test('convergent direction prompts make new mechanisms traceable extensions of earlier ideas', () => {
  const high = directionPlannerSystemPrompt({ targetOrientation: 'C', magnitude: 'high' });
  assert.match(high, /integrated extension of the selected ideas/i);
  assert.match(high, /concrete role/i);
  assert.match(high, /not an independent or disconnected programme/i);

  const low = directionPlannerSystemPrompt({ targetOrientation: 'C', magnitude: 'low' });
  assert.match(low, /two selected ideas/i);
  assert.match(low, /bridge element/i);
  assert.match(low, /how that bridge operates/i);
});

test('runs all applicable planner components concurrently and skips the writing summarizer when writing is empty', async () => {
  const calls: string[] = [];
  const completion = async (systemPrompt: string) => {
    calls.push(systemPrompt);
    if (systemPrompt.includes('earlier design ideas')) return '{"previousIdeas":["Cooling hubs."]}';
    return '{"directionGuidance":"Develop six genuinely different paths."}';
  };
  const result = await generateSplitGuidancePlanner({
    targetOrientation: 'D', magnitude: 'high', selectedContextMoves: [
      { moveId: 1, moveType: 1, orientation: 'D', description: 'Cooling hubs' },
    ], recentWritingContext: [], policyVersion: 'tm-context-v2', triggerOrientation: 'D', phase: 'collect', contextLimit: 1, availableContextCount: 1, requiredIdeaCount: 6,
  }, '', completion);

  assert.equal(calls.length, 2);
  assert.equal(result.writingSummarizer.status, 'skipped');
  assert.equal(result.writingContextSummary, undefined);
  assert.deepEqual(result.previousIdeas, ['Cooling hubs.']);
});

test('keeps generating guidance with a component-specific fallback after planner failure', async () => {
  const completion = async (systemPrompt: string) => {
    if (systemPrompt.includes('earlier design ideas')) throw new Error('idea service unavailable');
    if (systemPrompt.includes('current design writing')) throw new Error('summary service unavailable');
    return '{"directionGuidance":"Develop a new coordination mechanism."}';
  };
  const result = await generateSplitGuidancePlanner({
    targetOrientation: 'C', magnitude: 'high', selectedContextMoves: [
      { moveId: 1, moveType: 4, orientation: 'C', description: 'Heat buddy transport connection' },
    ], recentWritingContext: [], policyVersion: 'tm-context-v2', triggerOrientation: 'C', phase: 'synthesize', contextLimit: 1, availableContextCount: 1, requiredIdeaCount: null,
  }, 'Residents use cooling hubs.', completion);

  assert.equal(result.ideaExtractor.status, 'fallback');
  assert.deepEqual(result.previousIdeas, ['Heat buddy transport connection']);
  assert.equal(result.writingSummarizer.status, 'fallback');
  assert.equal(result.writingContextSummary, undefined);
  assert.equal(result.directionPlanner.status, 'success');
});
