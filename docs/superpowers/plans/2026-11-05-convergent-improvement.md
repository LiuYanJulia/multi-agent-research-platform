# Convergent Improvement Guidance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reframe C-high and C-low guidance as useful integrated improvements to the participant's earlier ideas.

**Architecture:** Update the two convergent direction-planner contracts and their examples, then update the orientation-specific final guidance instruction. The existing planner interfaces, anti-repetition material, and response budgets remain unchanged.

**Tech Stack:** TypeScript, Node.js built-in test runner, OpenAI chat-completion prompts.

**Spec:** `docs/superpowers/specs/2026-11-05-convergent-improvement-design.md`

## Global Constraints

- Keep C-high at 80 English words and C-low at 50 English words.
- Do not change the manipulation mechanism, D conditions, memory inputs, anti-repetition logic, or planner-call structure.
- C-high must remain useful and integrated, not merely more novel or larger in scope.

## Review Focus

- C-high requires a substantial integrated improvement that preserves useful roles and resolves a practical joint-operation issue.
- C-low requires a focused feature-level improvement at the connection between earlier ideas.
- Final C guidance names the ideas/roles, the improved connection, mechanism, operation, and practical benefit within the existing budgets.
- D guidance retains its existing numbered-list presentation requirement and no C-only copy.
- Existing 80/50 C limits remain present in the final instruction.

---

### Task 1: Convergent-improvement prompt contracts

**Files:**
- Modify: `backend/src/agents/manipulationController.ts: DIRECTION_PROMPT_ADDITIONS.C_high and .C_low`
- Modify: `backend/src/routes/chat.ts: buildFinalGuidanceInstruction`
- Test: `backend/src/agents/manipulationController.test.ts`
- Test: `backend/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: `directionPlannerSystemPrompt(spec)` and `buildFinalGuidanceInstruction(planner, guidanceMemory, wordLimit, orientation)`.
- Produces: unchanged interfaces whose C prompt strings describe integrated improvement.

- [x] **Step 1: Write failing C prompt-contract tests**

Assert that C-high calls for a substantial integrated improvement, preserves useful roles, and targets a practical joint-operation issue; C-low calls for a focused feature-level improvement. Assert that final C instructions state the improved connection, mechanism, operation, and practical benefit, while D retains no C-only copy.

- [x] **Step 2: Run focused tests to verify they fail**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js dist/routes/chat.test.js`

Expected: FAIL because the current prompts use the older “extension/bridge” language without the complete improvement contract.

- [x] **Step 3: Update C planner prompts, few-shot examples, and final C instruction**

Replace only C-high/C-low prompt copy and the C-specific final presentation instruction. Keep word limits and D-specific instructions unchanged.

- [x] **Step 4: Run focused tests to verify they pass**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js dist/routes/chat.test.js`

Expected: PASS with zero failures.

- [x] **Step 5: Run full backend verification and commit**

Run: `cd backend && npm run build && node --test dist/agents/*.test.js dist/routes/*.test.js dist/services/*.test.js && git diff --check`

Expected: all tests pass and `git diff --check` produces no output.

Commit: `git commit -m "feat: frame convergent guidance as improvement"`
