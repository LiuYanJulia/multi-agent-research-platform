# Guidance Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate concise, condition-preserving guidance with explicit writing and delivered-guidance memory, and make every generation stage auditable.

**Architecture:** Add a planner result to the controller guidance contract, reserve the 100-second delivery slot before LLM work, and make the direct-guidance route create a structured audit bundle. The direct-response call keeps normal chat turns but receives historical guidance only through a clearly labelled memory. Debug stages expose the planner result.

**Tech Stack:** TypeScript, Express, mysql2, OpenAI Chat Completions, React, node:test, Jest.

**Spec:** `docs/superpowers/specs/2026-10-29-guidance-memory-design.md`

## Global Constraints

- Preserve High-D 120, Low-D 40, High-C 70, Low-C 40 word limits and existing display summaries.
- Exclude only historical `ai_guidance` from automatic-guidance conversational context; normal prompt responses are unchanged.
- Log all stage I/O beside the originating evaluation audit turn.
- Use the most recent three delivered guidance cards as guidance memory.

## Review Focus

- A cooldown-blocked intervention must never call either guidance LLM.
- Historic guidance must occur once, in labelled memory, not as an assistant turn.
- Blank writing must yield an explicit empty writing summary without treating task text as participant writing.
- Audit updates must remain bound to the originating `turn_index`.
- Planner output shown in the Debug Panel must not expose a stale prior card.

### Task 1: Planner contract and condition-specific direction

**Files:**
- Modify: `backend/src/agents/manipulationController.ts`
- Test: `backend/src/agents/manipulationController.test.ts`

- [x] Write failing tests for planner JSON parsing and Low-C/Low-D direction requirements.
- [x] Implement planner input/output types, LLM call, writing-summary generation, and condition direction validation.
- [x] Run backend controller tests.

### Task 2: Delivery gate, memory-aware response, and audit bundle

**Files:**
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/services/manipulationPipeline.ts`
- Modify: `backend/src/services/evaluationAuditExport.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/routes/chat.test.ts`

- [x] Write failing route tests for a 100-second gate and separated guidance memory.
- [x] Reserve the delivery slot before planner work; filter old `ai_guidance` from automatic-guidance turns; add planner and response I/O to the matching audit row.
- [x] Export audit bundles in JSON and Markdown.
- [x] Run backend route tests.

### Task 3: Substantive-content filtering and Debug Panel

**Files:**
- Modify: `backend/src/agents/moveTypeEvaluator.ts`
- Modify: `backend/src/services/manipulationPipeline.ts`
- Modify: `frontend/src/components/DebugPanel.tsx`
- Modify: `frontend/src/components/DebugPanel.test.tsx`

- [x] Write failing tests for task-paste/noise filtering and planner-output expansion.
- [x] Implement filters and the planner-output debug stage.
- [x] Run focused backend and frontend tests.

### Task 4: End-to-end verification

- [x] Run backend test suite, frontend test suite, frontend type-check, and `git diff --check`.
- [ ] Review the branch diff against the spec and commit the feature.

