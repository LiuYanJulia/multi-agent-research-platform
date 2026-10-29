# Actual-task Guidance Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render delivered proactive guidance above both Practice and Actual writing areas while preserving chat notifications and guidance delivery behavior.

**Architecture:** `ChatInterface` will report loaded and newly delivered guidance to `ResearchPageActual`, while excluding those cards from its own message stream. A new `GuidancePanel` component will own bounded, scrollable presentation. `WebRTCTranscript` will provide its existing recording/connection status through an optional render callback placed above the chat component.

**Tech Stack:** React 19, TypeScript, Create React App/Jest, existing inline component styling.

**Spec:** `docs/superpowers/specs/2026-10-29-guidance-panel-design.md`

## Global Constraints

- Keep the existing AI-guidance notification in the chat panel.
- Show only three newest cards, flash a new card exactly five times, and retain all existing logging and debug behavior.
- Guidance box copy must be exactly: `Proactive AI guidance will be shown here. Please consider them into your own thinking`.
- Do not modify backend guidance generation or delivery code.

## Review Focus

- Restored history containing more than three guidance records must show only the newest three.
- A deferred guidance record must remain absent from the panel until its scheduled display time.
- A new guidance must leave the normal chat response stream unchanged.
- Empty-state guidance box must remain visible and scroll container must not expand the page.
- Recording/connection status must use the live `WebRTCTranscript` state, not a second status source.

### Task 1: Guidance presentation contract and panel

**Files:**
- Create: `frontend/src/components/GuidancePanel.tsx`
- Create: `frontend/src/components/GuidancePanel.test.tsx`
- Modify: `frontend/src/components/ChatInterface.tsx`
- Modify: `frontend/src/components/ChatInterface.test.tsx`

**Interfaces:**
- Produces `DisplayedGuidance` and `GuidancePanel` for `ResearchPageActual`.
- `ChatInterface` accepts `onGuidanceChange(guidance: DisplayedGuidance[]): void`.

- [ ] Write failing panel tests for exact empty copy, three-card bound, and five-iteration animation class.
- [ ] Run the focused test to verify it fails before the component exists.
- [ ] Implement `GuidancePanel` and report filtered history/new deliveries from `ChatInterface` without rendering `ai_guidance` in chat.
- [ ] Run focused panel and chat tests to verify they pass.
- [ ] Commit the presentation contract and panel.

### Task 2: Actual-task layout and live status placement

**Files:**
- Modify: `frontend/src/pages/ResearchPageActual.tsx`
- Modify: `frontend/src/pages/ResearchPagePractice.tsx`
- Modify: `frontend/src/components/WebRTCTranscript.tsx`
- Modify: `frontend/src/components/WebRTCTranscript.test.tsx` if needed
- Modify: `frontend/src/index.css`

**Interfaces:**
- Consumes `DisplayedGuidance`, `GuidancePanel`, and `WebRTCTranscript` optional `renderStatus` callback.
- Produces the right-pane order in both task pages: guidance panel then writing section; the guidance panel occupies one third of right-pane height.

- [ ] Write a failing focused rendering test for the empty guidance panel at the Actual-page boundary or for its panel component contract.
- [ ] Implement the three-row right grid and relocate the live status renderer to the left chat panel.
- [ ] Run focused frontend tests and production build.
- [ ] Commit the layout implementation.

### Task 3: Verification

**Files:**
- Modify only if verification reveals a defect.

- [ ] Run the complete relevant Jest suite and `npm run build`.
- [ ] Verify `git diff --check` and manually inspect the actual layout with the development server.
- [ ] Commit any verification fix.
