# AI Guidance Policy Prompts

`backend/src/agents/manipulationController.ts` uses four system prompts for the guidance-generation LLM: High/Low TM crossed with Divergent/Convergent guidance.

Each prompt returns JSON only:

```json
{
  "directionGuidance": "...",
  "previousIdeas": ["short keyword phrase"]
}
```

`directionGuidance` is determined by the experimental condition. High Divergent requests at least six numbered, distinct directions. Low Divergent requests exactly two nearby variants. High Convergent requests a genuine synthesis of all compatible ideas. Low Convergent requests a small compatible merge developed through one concrete design detail.

`previousIdeas` is generated from two context-data sections: the selected content-move descriptions and, when available, the semantic writing-change result. It must contain short readable keywords, never copied move descriptions or writing excerpts. `REMOVED` writing items are context for understanding the participant's revision, but must not become previous ideas.

The runtime context is treated as data, not instructions:

```text
Selected move descriptions:
1. ...

Recent writing context, extracted by a separate comparison step:
1. ADDED: ...
2. REVISED: ...
3. REMOVED: ...
```

The controller validates the directional contract. On model or parsing failure, it uses a deterministic direction fallback and a safe generic previous-ideas phrase. The main response model then receives the combined direction guidance and previous-ideas line with `Keep the answers concise and coherent.`
