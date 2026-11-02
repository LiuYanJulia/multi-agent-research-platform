# Parallel Guidance Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate auditable, condition-specific proactive guidance through three parallel planner calls and make the guidance/writing panels scroll correctly in the user11 experiment branch.

**Architecture:** Replace the all-in-one planner with independent writing-summary, idea-extraction, and direction-planning components. The final guidance request combines their results conditionally with displayed guidance memory, while per-component failures use explicit fallbacks and remain visible in the research audit. A chronological user11 fixture exercises consecutive cards without pretending that simple string comparison proves semantic novelty.

**Tech Stack:** TypeScript, Express, OpenAI Chat Completions, MySQL audit records, Node test runner, React, Jest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-guidance-planner-split-design.md`

## Global Constraints

- Work only on branch `codex/guidance-layout-demo` in `/Users/yanliu/.codex/worktrees/guidance-layout-demo/Manipulation research-platform`.
- Run three planner calls concurrently; inputs are isolated exactly as the spec defines.
- Generate guidance even when a planner component falls back; never replace failed writing summary with a character-truncated draft.
- Do not implement a normal-chat coverage ledger, adopt/evaluate-move filter, or post-generation novelty retry/checker.
- Keep final word limits: D-high 120, D-low 50, C-high 80, C-low 50.
- Persist raw planner outputs and per-component error/fallback information only in the existing test/research audit path.

## Review Focus

- Empty writing skips the summarizer and omits `Existing writing` entirely from the final request; test in Tasks 2 and 3.
- A sentence-ending `previousIdeas` item remains valid; test in Task 1.
- One failed planner component still yields a card with only its documented fallback; test in Task 2.
- A prior-guidance-free first card omits `Earlier suggestions`; a later card includes it; test in Tasks 3 and 4.
- A newly displayed card is scrolled into the visible guidance-panel viewport after DOM render, while wheel input scrolls the writing panel; test in Tasks 5 and 6.

---

### Task 1: Define split-planner contracts and condition prompts

**Files:**
- Modify: `backend/src/agents/manipulationController.ts`
- Test: `backend/src/agents/manipulationController.test.ts`

**Interfaces:**
- Produces `GuidancePlannerComponentTrace<T>`, `SplitGuidancePlannerResult`, `generateSplitGuidancePlanner(spec, currentWriting)` and prompt builders consumed by `backend/src/routes/chat.ts`.
- Consumes `GuidanceSpec` and the selected move descriptions produced by the controller.

- [ ] **Step 1: Write failing parser/prompt tests**

Add tests that assert the idea parser accepts a complete phrase ending in `.`, each direction parser requires only a non-empty JSON `directionGuidance`, and each condition prompt includes two few-shot input/output examples plus the approved condition requirement.

- [ ] **Step 2: Run the focused controller tests to verify failure**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js`

Expected: FAIL because split planner builders and relaxed parsers do not exist.

- [ ] **Step 3: Add the three output types and isolated prompt builders**

Implement:

```ts
type WritingSummaryOutput = { writingContextSummary: string };
type IdeaExtractionOutput = { previousIdeas: string[] };
type DirectionOutput = { directionGuidance: string };
```

Implement builders whose inputs are respectively `currentWriting`, `selectedContextMoves`, and `{ targetOrientation, magnitude, selectedContextMoves }`. Embed the signed-off common direction preamble, all four condition additions, and their two examples each. Remove `plannerDirectionMeetsContract`, the joint JSON parser, and punctuation/keyword phrase rejection from this new path.

- [ ] **Step 4: Run focused controller tests to verify pass**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add backend/src/agents/manipulationController.ts backend/src/agents/manipulationController.test.ts
git commit -m "refactor: split guidance planner contracts"
```

### Task 2: Implement parallel planner execution and component fallbacks

**Files:**
- Modify: `backend/src/agents/manipulationController.ts`
- Test: `backend/src/agents/manipulationController.test.ts`

**Interfaces:**
- Consumes Task 1 output types and builders.
- Produces `SplitGuidancePlannerResult` containing three component traces and merged `directionGuidance`, `previousIdeas`, and optional `writingContextSummary`.

- [ ] **Step 1: Write failing execution tests**

Mock the completion client and assert: non-empty writing starts three requests concurrently; empty writing starts only idea/direction requests; an idea-call failure falls back to raw selected descriptions; a direction failure uses the condition deterministic direction; a writing failure returns no summary rather than a 900-character slice.

- [ ] **Step 2: Run the focused tests to verify failure**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js`

Expected: FAIL because `generateSplitGuidancePlanner` is absent.

- [ ] **Step 3: Implement `generateSplitGuidancePlanner`**

Start direction and idea calls together, and add writing summary to the same `Promise.all` only when `currentWriting.trim()` is non-empty. Each trace records system prompt, runtime input, raw output, model, start/completion time, status (`success`, `fallback`, `skipped`), error category (`timeout`, `api_error`, `invalid_json`, `missing_field`), and fallback output. Preserve guidance production on every component fallback.

- [ ] **Step 4: Run focused tests to verify pass**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add backend/src/agents/manipulationController.ts backend/src/agents/manipulationController.test.ts
git commit -m "feat: run guidance planner components in parallel"
```

### Task 3: Assemble conditional final guidance input and complete audit trace

**Files:**
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/services/manipulationPipeline.ts`
- Test: `backend/src/routes/chat.test.ts`

**Interfaces:**
- Consumes `SplitGuidancePlannerResult` from Task 2.
- Produces the persisted `guidance_generation_payload` with `writingSummarizer`, `ideaExtractor`, `directionPlanner`, `mainResponse`, and `delivery` stages.

- [ ] **Step 1: Write failing chat-route tests**

Add pure-builder tests for final request construction: Direction and Earlier participant ideas are always present; Existing writing appears only after summary success; Earlier suggestions appears only when memory is non-empty; the main system prompt and user task repetition use the signed-off text; condition word limits remain 120/50/80/50.

- [ ] **Step 2: Run focused route tests to verify failure**

Run: `cd backend && npm run build && node --test dist/routes/chat.test.js`

Expected: FAIL because the route always inserts writing/memory placeholders and logs a single planner result.

- [ ] **Step 3: Implement the conditional final prompt and audit payload**

Replace `DIRECT_GUIDANCE_MEMORY_SYSTEM_PROMPT` with the approved complete final system prompt. Build final user-message sections in the approved order, adding optional sections only when actual data exists, followed by the repeated task wording and existing formatting/word-limit instruction. Log every component trace, the exact final messages, response output/model, and delivery result via `updateGuidanceGenerationAudit`.

- [ ] **Step 4: Run focused route tests to verify pass**

Run: `cd backend && npm run build && node --test dist/routes/chat.test.js`

Expected: PASS.

- [ ] **Step 5: Commit Task 3**

```bash
git add backend/src/routes/chat.ts backend/src/services/manipulationPipeline.ts backend/src/routes/chat.test.ts
git commit -m "feat: audit split guidance generation"
```

### Task 4: Build the user11 consecutive-guidance regression fixture

**Files:**
- Create: `backend/src/agents/fixtures/user11GuidanceSequence.ts`
- Create: `backend/src/agents/user11GuidanceSequence.test.ts`
- Modify: `backend/package.json`

**Interfaces:**
- Consumes `generateSplitGuidancePlanner` with an injectable completion client and user11-derived fixture records.
- Produces a test report containing component traces, final prompt section presence, simulated delivered cards, and repeated-mechanism markers.

- [ ] **Step 1: Write the failing chronological fixture test**

Extract the seven formerly fallback user11 cases from `/Users/yanliu/uploads_20261101_232321/evaluation_audits/evaluation_audit_Pilot_user11_1793542774373.json`, copying only condition, selected moves, current writing, and preceding visible guidance into a repository fixture; do not commit participant-identifying audit metadata. Encode them in original order. Assert that every case yields a merged planning result, each later case receives prior simulated visible guidance, empty-writing cases skip summary, and audit traces preserve failures/fallbacks.

- [ ] **Step 2: Run the fixture test to verify failure**

Run: `cd backend && npm run build && node --test dist/agents/user11GuidanceSequence.test.js`

Expected: FAIL because the fixture runner does not exist.

- [ ] **Step 3: Implement the fixture runner and repeat-marker report**

Use deterministic mock completions for unit assertions. Add an opt-in script that may replay the same fixture through the configured model without printing credentials; write the resulting JSON report to a gitignored test-artifact location. Report lexical/mechanism markers shared by a generated card and prior writing/guidance for human inspection, explicitly labelling them as signals rather than semantic-duplication verdicts.

- [ ] **Step 4: Run deterministic fixture tests to verify pass**

Run: `cd backend && npm run build && node --test dist/agents/user11GuidanceSequence.test.js`

Expected: PASS, with seven chronological records and component-level audit data.

- [ ] **Step 5: Run the opt-in model replay and inspect its report**

Run: `cd backend && npm run test:guidance-user11-replay`

Expected: a local report with seven successive cards, all component raw outputs/statuses, final prompt section presence, and labelled overlap markers.

- [ ] **Step 6: Commit Task 4**

```bash
git add backend/src/agents/fixtures/user11GuidanceSequence.ts backend/src/agents/user11GuidanceSequence.test.ts backend/package.json
git commit -m "test: add user11 guidance sequence regression fixture"
```

### Task 5: Port and test guidance-panel auto-reveal

**Files:**
- Modify: `frontend/src/components/GuidancePanel.tsx`
- Modify: `frontend/src/components/GuidancePanel.test.tsx`

**Interfaces:**
- Produces an effect that scrolls the guidance panel to a newly displayed card after React renders it.

- [ ] **Step 1: Write the failing UI test**

Mock the guidance-panel card element and its scroll container. Display a deferred guidance card and assert that its beginning is revealed only after the card is added to state/DOM.

- [ ] **Step 2: Run the focused frontend test to verify failure**

Run: `cd frontend && npm test -- --runInBand ChatInterface.test.tsx`

Expected: FAIL because no new-card reveal state/effect exists.

- [ ] **Step 3: Implement deferred guidance-card reveal**

After render, locate the newly delivered card in its actual GuidancePanel container and scroll that container enough to reveal the card beginning. Preserve user scrolling for existing cards.

- [ ] **Step 4: Run focused frontend test to verify pass**

Run: `cd frontend && npm test -- --runInBand ChatInterface.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit Task 5**

```bash
git add frontend/src/components/GuidancePanel.tsx frontend/src/components/GuidancePanel.test.tsx
git commit -m "fix: reveal newly displayed guidance"
```

### Task 6: Restore mouse-wheel scrolling in the writing panel

**Files:**
- Modify: `frontend/src/components/WritingSection.tsx`
- Modify: `frontend/src/components/WritingSection.test.tsx`

**Interfaces:**
- Produces an independently scrollable writing-and-submission flex region containing the editor and controls.

- [ ] **Step 1: Write the failing layout/scrollability test**

Render long writing content and assert that the writing panel has a constrained flex height and `overflowY: auto`, while the editor does not force the containing page to grow beyond the panel.

- [ ] **Step 2: Run the focused frontend test to verify failure**

Run: `cd frontend && npm test -- --runInBand WritingSection.test.tsx`

Expected: FAIL because the writing region is not a dedicated scroll container.

- [ ] **Step 3: Implement the scroll container**

Wrap the editor/submission content in a `minHeight: 0`, flex-growing container with vertical overflow and prevent the editor from shrinking the scroll parent incorrectly. Keep rich-text editing, save, and submission behavior unchanged.

- [ ] **Step 4: Run the focused frontend test to verify pass**

Run: `cd frontend && npm test -- --runInBand WritingSection.test.tsx`

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add frontend/src/components/WritingSection.tsx frontend/src/components/WritingSection.test.tsx
git commit -m "fix: scroll writing and submission panel"
```

### Task 7: Full verification and research-audit handoff

**Files:**
- Modify only if verification exposes a defect in a prior task.

**Interfaces:**
- Consumes all completed tasks.
- Produces a clean target-branch test result and one user11 replay report for review.

- [ ] **Step 1: Run backend tests**

Run: `cd backend && npm run build && node --test dist/agents/*.test.js dist/routes/*.test.js dist/services/*.test.js`

Expected: PASS.

- [ ] **Step 2: Run frontend tests**

Run: `cd frontend && npm test -- --runInBand`

Expected: PASS.

- [ ] **Step 3: Run the user11 opt-in replay and inspect all seven chronological records**

Run: `cd backend && npm run test:guidance-user11-replay`

Expected: every case contains three component audit traces, a final-response trace, optional-section status, and overlap signals for human review.

- [ ] **Step 4: Inspect the target worktree status and commit any verification-only corrections**

Run: `git status --short`

Expected: clean except for intentionally retained replay artifacts, which must be gitignored.

## Self-Review

- Spec coverage: Tasks 1-4 cover split calls, prompts, component fallbacks, final message composition, per-step audit data, and user11 sequence replay. Tasks 5-6 cover both requested UI fixes. Task 7 verifies the integrated result.
- Type consistency: Task 1 establishes all split result types; Tasks 2-4 consume `SplitGuidancePlannerResult`; the route is the sole assembler of final guidance messages.
- Review-focus coverage: the five listed risk classes map to Tasks 2-6 as stated.
- Proportion: the plan specifies public interfaces, tests, exact prompt behaviour, and commands without prescribing implementation bodies.
