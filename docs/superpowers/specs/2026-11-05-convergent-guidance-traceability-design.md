# Convergent Guidance Traceability Design

## Intent

Participants receiving synthesis guidance should be able to see immediately why the proposed connection follows from their earlier ideas. High-magnitude convergence must extend and operationalise those ideas rather than introduce a parallel, overly divergent programme. Low-magnitude convergence must show the same lineage at a smaller scope.

## Scope

Change only the backend prompts used for C-high and C-low guidance generation, plus their automated prompt-contract tests. Preserve the existing generation pipeline, audit data, word limits (80 for C-high and 50 for C-low), and all divergent-condition behaviour.

## Design

The C-high direction-planner prompt will require the new mechanism to function as a bridge, coordination layer, or operational extension of the selected ideas. Its direction must identify the concrete roles of the contributing ideas and the workflow, dependency, or trade-off that joins them. It must not replace them with a disconnected programme.

The C-low direction-planner prompt will require a traceable connection between two selected ideas: a concrete bridge element and the triggering, handoff, or interaction it creates. It remains local in scope.

The final guidance instruction for every convergent response will require its first sentence to name the relevant earlier ideas (or their roles) and the new bridge mechanism. Its concise Markdown points must explain how the connection operates. This is a presentation requirement for the participant-facing response, not an additional LLM call or a change to the word budget.

## Non-goals

- Do not expose the private planner direction itself.
- Do not force every selected idea into the visible response when only two or three are relevant.
- Do not change the anti-repetition constraints, memory inputs, cooldown, or task prompts.
- Do not add a programmatic, fixed-format connection block.

## Acceptance Criteria

- The C-high planner requires an integrated extension of selected ideas and rejects a separate parallel programme in its prompt instructions.
- The C-low planner requires an explicit two-idea bridge and operational link.
- The final C guidance instruction requires a visible first-sentence provenance statement and explanation of how the connection works.
- The D final instruction has no new convergent-only presentation requirement.
- The backend test suite passes.
