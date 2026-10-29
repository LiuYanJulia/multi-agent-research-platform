# Guidance Word Limits and Cooldown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the four approved guidance-response word limits, visibly label guidance orientation, and require two minutes between controller-approved guidance deliveries.

**Architecture:** Keep guidance-generation and presentation contracts deterministic in the controller: a pure word-limit helper drives the Main Response prompt and the existing summary generator emits the visible orientation tag. Keep delivery throttling atomic in MySQL by changing the existing conditional update from 60 to 120 seconds; the Controller remains solely responsible for deciding whether guidance is eligible to deliver.

**Tech Stack:** TypeScript; Express; MySQL; Node built-in test runner; React Testing Library; Create React App.

**Spec:** `docs/superpowers/specs/2026-10-29-guidance-word-limits-and-cooldown-design.md`

## Global Constraints

- High-D guidance response: at most 120 English words.
- Low-D guidance response: at most 40 English words.
- High-C guidance response: at most 70 English words.
- Low-C guidance response: at most 40 English words.
- Prefix D summaries with `[Exploration]` and C summaries with `[Synthesis]`.
- The two-minute cooldown applies only after the Manipulation Controller has approved a guidance card for delivery; it must never independently create guidance.
- Use one global 120-second delivery cooldown regardless of phase, condition, or writing activity.

## Review Focus

- Every D/C × high/low combination must resolve to its exact specified word limit; cover all four in the controller unit test.
- Stored and newly delivered D/C cards must show the orientation label at the beginning of the muted summary; cover both via summary tests and the existing card render test.
- Guidance still cannot be delivered when a previous participant-visible card is less than 120 seconds old; preserve the existing atomic conditional `UPDATE` reservation.
- A controller decision that does not intervene must never be converted into a timer-driven guidance delivery; confirm the reservation remains inside the `if (guidance)` path.
- Control/practice behavior and trigger logic must remain unchanged; build the backend and inspect the changed delivery path without adding a scheduled trigger.

---

### Task 1: Make the deterministic guidance contract testable and update the card label

**Files:**
- Modify: `backend/src/agents/manipulationController.ts:358-375`
- Create: `backend/src/agents/manipulationController.test.ts`
- Modify: `frontend/src/components/ChatInterface.test.tsx:75-105`

**Interfaces:**
- Produces: `guidanceResponseWordLimit(targetOrientation: Orientation, magnitude: TmLevel): number`, used by `makePromptForResponse`.
- Produces: `guidanceDisplaySummary(spec): string`, prefixed with the D/C orientation label.

- [ ] **Step 1: Write failing controller contract tests**

Use Node's built-in test runner to assert all four `guidanceResponseWordLimit` mappings and that `guidanceDisplaySummary` begins `[Exploration]` for D and `[Synthesis]` for C.

- [ ] **Step 2: Run the controller contract test and verify it fails**

Run: `npm run build && node --test dist/agents/manipulationController.test.js` from `backend`

Expected: FAIL because the helper is not exported and summaries have no orientation prefix.

- [ ] **Step 3: Implement the pure mapping and tagged summary**

Add `guidanceResponseWordLimit(targetOrientation, magnitude)` with the exact four global values. Use it inside `makePromptForResponse`. Prefix the existing summary text with `[Exploration]` when `targetOrientation === 'D'`, otherwise `[Synthesis]`, preserving the existing human-readable sentence after the label.

- [ ] **Step 4: Update the participant-card render test**

Change the existing guidance-history fixture and visible assertion to include `[Exploration]`, proving that the muted first line shown to participants renders the server-provided tag without exposing private context.

- [ ] **Step 5: Run focused tests and verify they pass**

Run: `npm run build && node --test dist/agents/manipulationController.test.js` from `backend`; then `CI=true npm test -- --watch=false --runInBand ChatInterface.test.tsx` from `frontend`.

Expected: both commands PASS.

### Task 2: Change the delivery reservation to a global two-minute cooldown

**Files:**
- Modify: `backend/src/routes/chat.ts:83-99`

**Interfaces:**
- Consumes: controller-created `guidance` payload from the existing `if (guidance)` branch.
- Produces: atomic participant-visible-card reservation only when the prior reservation is at least 120 seconds old.

- [ ] **Step 1: Write the failing cooldown assertion in the controller contract test**

Add a testable exported cooldown constant from a small `backend/src/services/guidanceDelivery.ts` helper, expecting `120`. Move no scheduling behavior into the helper; it represents only the duration used by the existing route reservation.

- [ ] **Step 2: Run the backend contract test and verify it fails**

Run: `npm run build && node --test dist/agents/manipulationController.test.js` from `backend`.

Expected: FAIL because the cooldown helper does not yet exist.

- [ ] **Step 3: Implement the shared 120-second cooldown value and use it in the atomic reservation**

Create `guidanceDelivery.ts` exporting `GUIDANCE_NOTIFICATION_COOLDOWN_SECONDS = 120`. Import it in `chat.ts` and interpolate that value into the existing `DATE_SUB(CURRENT_TIMESTAMP, INTERVAL ... SECOND)` predicate. Leave the reservation entirely inside `if (guidance)` and retain deletion of an over-throttled generated message.

- [ ] **Step 4: Run the focused contract test and verify it passes**

Run: `npm run build && node --test dist/agents/manipulationController.test.js` from `backend`.

Expected: PASS.

- [ ] **Step 5: Run project verification**

Run: `npm run build` from `frontend`, `npm run build` from `backend`, `CI=true npm test -- --watch=false --runInBand ChatInterface.test.tsx` from `frontend`, and `git diff --check` from the repository root.

Expected: build commands, focused frontend test, backend contract test, and diff check all succeed.
