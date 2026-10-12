/**
 * Check if a session ID indicates a practice session
 * Practice sessions have IDs starting with "practice_"
 */
export function isPracticeSession(sessionId: string): boolean {
  return sessionId.startsWith('practice_');
}

/**
 * Paper 2 (2026-09) test mode: sessionId is built as `${userId}_${timestamp}` for the actual
 * session and `practice_${userId}_${timestamp}` for practice (see frontend/src/App.tsx). A
 * participant/tester whose userId starts with "test" (case-insensitive) gets the same interface
 * as everyone else, plus a debug panel (live transcript + agent execution stage timeline) - see
 * PAPER2_MANIPULATION_PLAN.md section 11. Gating this server-side too (not just in the frontend)
 * means we never spend the extra SSE writes / stage bookkeeping on a real participant's session.
 */
export function isTestSession(sessionId: string): boolean {
  const withoutPracticePrefix = isPracticeSession(sessionId)
    ? sessionId.slice('practice_'.length)
    : sessionId;
  return withoutPracticePrefix.toLowerCase().startsWith('test');
}
