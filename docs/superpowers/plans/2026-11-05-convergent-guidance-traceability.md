# Convergent Guidance Traceability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make C-high and C-low AI guidance visibly traceable to the participant's earlier ideas while preserving the current word limits.

**Architecture:** Strengthen the two convergent direction-planner prompts so their generated direction treats new mechanisms as operational links between earlier ideas. Add an orientation-specific instruction to the final guidance user message, ensuring the participant-facing response identifies its source connection and briefly explains its operation.

**Tech Stack:** TypeScript, Node.js built-in test runner, OpenAI chat-completion prompts.

**Spec:** `docs/superpowers/specs/2026-11-05-convergent-guidance-traceability-design.md`

## Global Constraints

- Preserve C-high at 80 English words and C-low at 50 English words.
- Do not modify divergent (D-high or D-low) prompt requirements.
- Do not change the number of planner calls or the data sent to the final generator.

## Review Focus

- C-high must describe an extension of earlier ideas, not a new independent programme; test its prompt includes both constraints.
- C-low must make the two-idea bridge and its operational effect explicit; test its prompt includes both constraints.
- C participant-facing guidance must surface provenance in the first sentence; test the final instruction contains this requirement.
- D participant-facing guidance must retain its numbered-list requirement and not receive the convergent-only wording; test both instruction variants.
- The fixed 80/50 C word limits remain unchanged; test the generated instructions retain them.

---

### Task 1: Convergent planner and final-response prompt contracts

**Files:**
- Modify: `backend/src/agents/manipulationController.ts: DIRECTION_PROMPT_ADDITIONS.C_high and .C_low`
- Modify: `backend/src/routes/chat.ts: buildFinalGuidanceInstruction`
- Test: `backend/src/agents/manipulationController.test.ts`
- Test: `backend/src/routes/chat.test.ts`

**Interfaces:**
- Consumes: `directionPlannerSystemPrompt(spec)` and `buildFinalGuidanceInstruction(planner, guidanceMemory, wordLimit, orientation)`.
- Produces: unchanged prompt-builder interfaces with stronger C prompt contracts.

- [x] **Step 1: Write failing prompt-contract tests**

Add assertions that C-high includes integrated extension, concrete roles, and a prohibition on a disconnected programme; C-low includes a two-idea bridge and operational effect. Add assertions that C final instructions require the first sentence to name earlier ideas/roles plus the bridge, and explain how the connection works, while D retains only its existing divergent list requirement.

- [x] **Step 2: Run the focused tests to verify they fail**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js dist/routes/chat.test.js`

Expected: FAIL because the current prompt copy lacks the new C-specific contract language.

- [x] **Step 3: Strengthen the C-high and C-low direction prompts and the C final instruction**

Modify only the strings in the named functions/constants. Require bridge/extension lineage for C-high, a concrete two-idea bridge for C-low, and visible provenance plus operational explanation for final C guidance. Keep all existing word-limit and D-specific text intact.

- [x] **Step 4: Run focused tests to verify they pass**

Run: `cd backend && npm run build && node --test dist/agents/manipulationController.test.js dist/routes/chat.test.js`

Expected: PASS with zero failures.

- [x] **Step 5: Run the full backend suite and commit**

Run: `cd backend && npm run build && node --test dist/agents/*.test.js dist/routes/*.test.js dist/services/*.test.js && git diff --check`

Expected: all tests pass and `git diff --check` reports no output.

Commit: `git commit -m "feat: clarify convergent guidance links"`
