import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTargetSection } from './logging';

test('accepts the raw guidance section for interaction-log storage', () => {
  assert.equal(normalizeTargetSection('guidance'), 'guidance');
});

test('stores an unknown interaction-log section as null rather than failing its batch', () => {
  assert.equal(normalizeTargetSection('unexpected-section'), null);
});
