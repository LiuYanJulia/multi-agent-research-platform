# Guidance Memory Design

## Intent

Make automatically delivered guidance less repetitive without changing the four experimental conditions' orientation, magnitude, response word limits, standard display summaries, or normal prompt-response behavior.

## Approved behavior

- Once the controller identifies an intervention, it may start guidance generation only when more than 100 seconds have elapsed since the prior displayed guidance. The existing notification/display path remains; no extra wait is added to force a 120-second display interval.
- A planner LLM receives the condition, selected participant moves, complete current writing, and the latest three delivered guidance cards. It returns `directionGuidance`, grounded `previousIdeas`, and `writingContextSummary`.
- The final guidance-response LLM receives normal conversation context with historic `ai_guidance` rows excluded, plus an explicit guidance memory of the latest three delivered cards and the planner's writing summary. These memories are negative constraints: do not repeat advice or writing already covered.
- Low-C must request one focused connection through a concrete scenario, feature, interaction, or design decision. Low-D must request two nearby variations that change distinct small dimensions not used by recent guidance. High-C and High-D retain their existing magnitude contracts.
- Filter task-description pastes, fragments, and generic non-design content before they can count as substantive streak moves.
- For every controller intervention attempt, save an audit bundle with gate input/output. For eligible attempts, append planner input/output, final-response input/output, and delivery input/output to the evaluation audit record for the same turn. Suppressed attempts contain only their gate result.
- Debug Panel exposes the planner output as a single expandable JSON block for each delivered guidance.

## Non-goals

- No semantic novelty gate/retry.
- No temperature change.
- No change to ordinary user-prompt main responses.
- No change to guidance panel layout or the existing presentation copy.

