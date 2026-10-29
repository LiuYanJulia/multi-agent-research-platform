import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildGuidancePlannerRuntimeInput,
  guidanceDisplaySummary,
  guidanceResponseWordLimit,
  parseGuidancePlannerOutput,
} from './manipulationController';
import { GUIDANCE_NOTIFICATION_COOLDOWN_SECONDS } from '../services/guidanceDelivery';

test('maps every orientation and magnitude to its approved guidance response word limit', () => {
  assert.equal(guidanceResponseWordLimit('D', 'high'), 120);
  assert.equal(guidanceResponseWordLimit('D', 'low'), 40);
  assert.equal(guidanceResponseWordLimit('C', 'high'), 70);
  assert.equal(guidanceResponseWordLimit('C', 'low'), 40);
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

test('planner output keeps rich participant context and requires a concrete low-C connection', () => {
  const output = parseGuidancePlannerOutput(JSON.stringify({
    directionGuidance: 'Make one focused connection through a concrete service interaction: show how a heat buddy books a cooling-hub visit after a check-in.',
    previousIdeas: ['neighbourhood heat buddy programme for seniors', 'subsidised transport to cooling hubs'],
    writingContextSummary: 'The proposal already assigns volunteers to check on isolated seniors and has proposed cooling hubs.',
  }), {
    targetOrientation: 'C', magnitude: 'low',
  });

  assert.deepEqual(output?.previousIdeas, ['neighbourhood heat buddy programme for seniors', 'subsidised transport to cooling hubs']);
  assert.match(output?.directionGuidance ?? '', /concrete service interaction/i);
  assert.match(output?.writingContextSummary ?? '', /isolated seniors/i);
});

test('planner output rejects a low-D direction unless it varies two different small dimensions', () => {
  const invalid = parseGuidancePlannerOutput(JSON.stringify({
    directionGuidance: 'Offer a nearby improvement to the cooling hubs.',
    previousIdeas: ['cooling hubs'],
    writingContextSummary: 'The draft proposes cooling hubs.',
  }), { targetOrientation: 'D', magnitude: 'low' });
  const valid = parseGuidancePlannerOutput(JSON.stringify({
    directionGuidance: 'Offer exactly two nearby variations, each changing a different small design dimension: one changes the check-in channel and one changes the travel-support trigger.',
    previousIdeas: ['neighbour check-ins', 'travel support'],
    writingContextSummary: 'The draft proposes cooling hubs and check-ins.',
  }), { targetOrientation: 'D', magnitude: 'low' });
  assert.equal(invalid, null);
  assert.ok(valid);
});

test('planner runtime input identifies delivered guidance and current writing as do-not-repeat context', () => {
  const input = buildGuidancePlannerRuntimeInput({
    targetOrientation: 'D', magnitude: 'low', selectedContextMoves: [], recentWritingContext: [],
  }, 'A current proposal draft about senior check-ins.', [
    'Connect cooling hubs with transport vouchers.',
    'Use heat buddies to call isolated residents.',
  ]);

  assert.match(input, /Already delivered guidance.*do not repeat/i);
  assert.match(input, /current proposal draft/i);
});
