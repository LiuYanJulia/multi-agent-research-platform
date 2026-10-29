# Actual-task AI Guidance Panel Design

## Intent

Keep proactive guidance visible beside the participant's writing work in both Practice and Actual tasks without changing the notification, guidance-generation, logging, or debug-panel flows. The participant should be able to read the chat and use the writing area without navigating back to a guidance message in the chat history.

## Confirmed behavior

- The existing countdown notification remains at the top of the left chat panel.
- When delivered, guidance is removed from the chat stream and displayed in a dedicated right-panel area above Writing & Submission.
- The panel title is outside its bordered guidance box. The box has a semi-transparent background, is roughly one third of the right panel, and scrolls internally.
- Before the first delivery, the empty box reads: `Proactive AI guidance will be shown here. Please consider them into your own thinking`.
- Keep only the three newest delivered guidance cards. A newly delivered card flashes five times.
- Move the combined `Audio recording active - speak naturally · Connected` status to the top of the left chat panel.
- The transcript component continues to own the realtime connection and recording state; only its compact display moves.

## Non-goals

- No backend, guidance-generation, guidance cooldown, data persistence, or debug-panel change.
- No change to the main response chat stream or its user-controlled scrolling behavior.

## Approach

Lift the presentation of delivered guidance from `ChatInterface` to both page components through optional callbacks. `ChatInterface` remains the owner of notification timing, interaction logging, and chat history retrieval. A small presentational component renders the bounded guidance panel. `WebRTCTranscript` exposes a compact-status mode so the same live status appears in the left chat panel without duplicating connection state.

## Approval

The user approved direct implementation in the request on 2026-10-29 after reviewing the frontend demo.
