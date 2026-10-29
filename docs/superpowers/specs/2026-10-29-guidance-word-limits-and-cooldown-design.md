# Guidance word limits and cooldown — short design

## Intent

Make AI guidance shorter and make its divergent/convergent intent immediately visible, while reducing how often guidance can appear.

## Scope

- High-D guidance response: at most 120 English words.
- Low-D guidance response: at most 40 English words.
- High-C guidance response: at most 70 English words.
- Low-C guidance response: at most 40 English words.
- Prefix the existing muted summary line with `[Exploration]` for D guidance and `[Synthesis]` for C guidance.
- Require a two-minute interval between all participant-visible guidance cards, regardless of condition or phase.

## Non-goals

- Do not infer whether a participant has started writing.
- Do not change the guidance trigger criteria, selected prior ideas, direction-generation prompts, or the main response prompt.
- Do not alter Practice-specific behavior beyond the existing shared backend guidance mechanics.

## Approaches considered

1. Use a writing-section activity signal to select a 2.5-minute writing cooldown. This adds a phase-detection dependency and can be ambiguous because the writing editor autosaves an empty draft on mount.
2. Use one global two-minute cooldown. **Selected:** it precisely matches the updated request, is atomic in the current database reservation query, and has no phase-detection or schema dependency.

## Implementation

- Replace the existing two-branch word-limit condition with a D/C × high/low mapping in `backend/src/agents/manipulationController.ts`.
- Generate the orientation label together with the deterministic display summary in that same module. The existing card view will render it in its already-muted first line, and stored message history/debug payloads will retain the exact visible summary.
- Change the cooldown predicate in `backend/src/routes/chat.ts` from 60 seconds to 120 seconds.
- Add focused unit coverage for the deterministic summary labels and word-limit mapping, then run frontend/backend builds and the applicable test suite.

## Acceptance criteria

- A High-D instruction says `Stay within 120 English words`; Low-D and Low-C say 40; High-C says 70.
- D card summaries begin `[Exploration]`; C card summaries begin `[Synthesis]`.
- A second guidance reservation is rejected until 120 seconds have elapsed, for every phase and condition.
