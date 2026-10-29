import assert from 'node:assert/strict';
import test from 'node:test';
import { MAIN_RESPONSE_SYSTEM_PROMPT } from './chat';

test('ends the actual-task main response prompt with an explicit concise-response instruction', () => {
  assert.match(MAIN_RESPONSE_SYSTEM_PROMPT, /Keep the response concise\.$/);
});
