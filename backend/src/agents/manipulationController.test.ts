import assert from 'node:assert/strict';
import test from 'node:test';
import {
  guidanceDisplaySummary,
  guidanceResponseWordLimit,
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
