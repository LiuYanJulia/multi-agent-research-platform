# Community Heat-Resilience Task Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task by task.

**Goal:** Replace the Actual experiment's career-development framing with the approved community heat-resilience design task, and give the Actual-session AI the same concise task context.

**Architecture:** Keep the Practice experiment unchanged. Update the Actual welcome copy and the server-side prompts used by the Main Response AI, speech transcription, and optional Decision Agent so all participant-facing and internal task context agree.

**Tech Stack:** React/TypeScript frontend; Express/TypeScript backend; Jest/React Testing Library; TypeScript builds.

**Spec:** User-approved conversation, 2026-10-29.

## Global constraints

- Change the Actual experiment only; retain the existing Practice task.
- Preserve Creativity and Usefulness as the evaluation criteria.
- The yellow reminder must avoid the product-manager framing and direct participants away from technical implementation details.
- The Main Response prompt must end with an instruction to keep replies concise and focused.

## Review focus

- The welcome page clearly states the heatwave problem, constrained public resources, and open-ended proposal space without excessive copy.
- AI context accurately reflects the same population, constraints, and design focus.
- No career-development wording remains in the Actual flow's relevant prompt surfaces.

---

### Task 1: Replace the Actual task copy and aligned AI task context

**Files:**
- Modify: `frontend/src/components/WelcomeActual.tsx`
- Modify: `backend/src/routes/chat.ts`
- Modify: `backend/src/routes/transcript.ts`
- Modify: `backend/src/agents/decisionAgent.ts`
- Create: `frontend/src/components/WelcomeActual.test.tsx`

**Step 1: Write the failing welcome-page test.**

Render `WelcomeActual` with a mocked `onStart`, then assert that the page exposes the community heat-resilience task, limited-resource context, Creativity and Usefulness criteria, and the people/service/partnership reminder. Assert the old product-manager framing is absent.

**Step 2: Run the focused frontend test and confirm it fails.**

Run: `CI=true npm test -- --watch=false --runInBand WelcomeActual.test.tsx`

Expected: FAIL because the current welcome page still renders the career-development task.

**Step 3: Implement the approved wording.**

Replace the Actual welcome task with the short community heat-resilience description and the revised reminder. Replace the Actual Main Response system prompt with the matching problem, populations, resource constraint, and design focus; append an explicit concise-response instruction. Update transcript and Decision Agent task context to the same domain without changing their behavior.

**Step 4: Run focused verification.**

Run: `CI=true npm test -- --watch=false --runInBand WelcomeActual.test.tsx`

Expected: PASS.

**Step 5: Run project verification.**

Run: `npm run build` in `frontend`, then `npm run build` in `backend`, and `git diff --check` from the repository root.

Expected: all commands succeed.
