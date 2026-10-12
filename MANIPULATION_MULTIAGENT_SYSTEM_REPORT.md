# Manipulation Multi-Agent System: Implementation Summary

This document describes the manipulation-related multi-agent system currently implemented in the research platform. It is written in two forms:

1. A detailed, end-to-end explanation for spoken reporting or a methods section.
2. A concise, slide-ready point-form version.

---

## Part A. Detailed System Walkthrough

### 1. System objective

The platform records how a participant collaborates with an AI chatbot while producing a design artefact. The manipulation system does not intervene arbitrarily. Instead, it reconstructs each user turn from multimodal interaction data, identifies the participant's design moves, determines the current Decision/Communication orientation, and conditionally provides a short adaptive guidance message.

The system has five runtime components:

1. **Event Timeline Builder**: transforms raw interaction, speech, and chat data into one ordered behavioural timeline.
2. **Evaluation Agent**: labels the participant's design moves using the six-category move taxonomy.
3. **Decision Agent**: independently classifies the current turn as Decision-oriented (D) or Communication-oriented (C).
4. **Manipulation Controller**: applies the experimental condition policy and decides whether to intervene.
5. **Main Response Agent**: produces the ordinary chatbot response to the user's message.

The Controller is deterministic rather than an LLM. This makes the experimental policy transparent, reproducible, and auditable.

### 2. Experimental condition mapping

Participants are assigned to one of five groups when the session begins:

| Group | Condition | System behaviour |
| --- | --- | --- |
| 1 | Control | No manipulation guidance is sent. |
| 2 | High task framing, high task manipulation | Encourages switching away from the current repeated D/C orientation. |
| 3 | High task framing, low task manipulation | Encourages the orientation matching the experimental target. |
| 4 | Low task framing, high task manipulation | Encourages switching away from the current repeated D/C orientation. |
| 5 | Low task framing, low task manipulation | Encourages the orientation matching the experimental target. |

High versus low task framing affects the wording and framing of the guidance templates. High versus low task manipulation affects the intervention rule used by the Controller.

### 3. Data captured during a participant turn

The frontend captures three streams of participant activity:

1. **Canvas/editor interaction logs**: for example, text insertion, paste, selection, object movement, style changes, grouping, and narration-related events.
2. **Speech transcript segments**: speech-to-text segments with timestamps.
3. **Chat messages**: the user message and the assistant response.

When the participant presses Send, the frontend first flushes the pending interaction-log batch. It then persists the user message and requests the chatbot response. This ordering is important: the editing activity immediately before Send becomes part of the same analytic turn rather than drifting into the next one.

The client also records the session start time. Interaction timestamps that are relative to session start are converted to absolute epoch time, allowing them to be aligned with speech and chat timestamps.

### 4. Event Timeline Builder

The Event Timeline Builder is the integration layer between raw platform data and the agentic analysis.

It reads `interaction_logs`, `speech_segments`, and `messages`, normalises their timestamps, and stores a rebuilt, ordered timeline in `session_events`. Rebuilding occurs after interaction logs or speech batches arrive, and again immediately before the per-turn pipeline runs.

The Builder also cleans raw behaviours before they reach the Evaluation Agent. Its processing includes:

1. Keeping meaningful root hover events rather than redundant nested hovers.
2. Removing selection-clear and CapsLock noise.
3. Deduplicating equivalent paste and text-insert events.
4. Consolidating related group behaviours.
5. Incorporating narration behaviour where applicable.
6. Merging fully contained speech segments and filtering filler-only speech.

The result is a compact, chronologically ordered sequence of typed events that can be inspected later and compared with the offline analysis pipeline.

### 5. Definition of an analytic turn

The system evaluates a **closed user turn** rather than a fixed time window.

A turn partition starts after the previous user message and ends at the current user message. It includes the participant's interaction events, speech segments, and the current user message in temporal order. The prior assistant response can therefore serve as context for what the participant is doing next.

At submission, the system also evaluates any remaining tail events after the final user message. This avoids losing behaviour that occurred near the end of a session.

### 6. Evaluation Agent: move-type coding

The Evaluation Agent uses the model specified by `EVAL_MODEL_ID`. In the current experimental design, this is the fine-tuned evaluation model rather than a general-purpose model.

It receives the current event partition and produces a sequential list of coded design moves. The move taxonomy is:

| Move type | Meaning |
| --- | --- |
| 1 | Explore / interpret the problem or design situation |
| 2 | Ask the chatbot a question |
| 3 | Generate or propose a design idea |
| 4 | Evaluate, compare, or revise an idea |
| 5 | Respond to or act on the chatbot's output |
| 6 | Externalise or execute a design action in the artefact |

The pipeline validates the returned output and checks expected counts for two especially important categories:

1. Type 2: user requests addressed to the AI.
2. Type 5: actions responding to the previous AI output.

If the result is malformed or fails these checks, the Evaluation Agent retries. A documented fallback preserves a usable result in the event of a model failure, so that the participant's session can continue rather than failing at runtime.

All predicted moves are stored in the move ledger. This means that later analyses can inspect the full move sequence, rather than only the single move that triggered a manipulation decision.

### 7. Decision Agent: D/C orientation coding

The Decision Agent has a separate responsibility from the Evaluation Agent. It receives:

1. The current turn partition.
2. The current evaluator-coded moves.
3. The preceding history of Decision-Agent-labelled moves.

It returns one orientation for the current turn:

1. **D (Decision-oriented)**: the participant is advancing, selecting, judging, or committing to a design direction.
2. **C (Communication-oriented)**: the participant is seeking, clarifying, eliciting, or exchanging information with the chatbot.

The Decision Agent is intentionally separate so that move taxonomy coding and D/C orientation can be tested, inspected, and improved independently.

One D/C judgement is attached to the latest content move in the current turn. Content moves are types 1, 3, 4, and 6. Types 2 and 5 still remain in the move ledger, but they do not independently drive the manipulation policy. This prevents one chat exchange from generating multiple contradictory D/C decisions.

### 8. Manipulation Controller: experimental policy

The Manipulation Controller receives the currently selected move with its D/C orientation, the participant's experimental group, and the recent labelled move history.

The Controller ignores control-group sessions. For the four manipulation groups, it applies the following policy:

1. **High task manipulation**: detect two consecutive content moves with the same orientation. When the participant is repeatedly D-oriented, send C-oriented guidance; when repeatedly C-oriented, send D-oriented guidance. After intervention, clear the streak so that the system does not repeatedly prompt on every subsequent move.
2. **Low task manipulation**: encourage the experimental target orientation. For a D-target condition, intervene only after two C moves; for a C-target condition, intervene only after two D moves.

If no rule fires, the Controller remains silent. It returns a structured decision record containing whether guidance should be sent, its desired orientation, the reason, and diagnostic context.

This separation is deliberate:

- LLMs interpret a complex multimodal design turn.
- Deterministic code enforces the experimental treatment rule.

### 9. Guidance generation and delivery

When the Controller decides to intervene, the system selects the appropriate guidance template for the condition and desired orientation. The wording differs between high and low task-framing conditions, but the guidance remains short and action-oriented.

The guidance is saved as an assistant message marked as `is_guidance`. It is then delivered through the existing chat streaming path and displayed as a distinct guidance bubble in the interface. Ordinary assistant replies continue to be generated and stored separately.

The system does not artificially append a type-5 move immediately after generating a normal chatbot response. The participant's actual subsequent response is coded as type 5 in the following turn. This preserves the causal order of the interaction.

### 10. Execution trace and research audit trail

Each per-turn pipeline execution writes an `agent_execution_log` record for the relevant steps:

1. `evaluation_agent`
2. `decision_agent`
3. `manipulation_controller`
4. `main_response_agent`

Each record can contain the turn index, input payload, output payload, selected model, start/end time, duration, status, error details, and retry count. The move ledger and session-event timeline complement these logs.

Together, these records allow the research team to reconstruct:

1. What the participant did.
2. How the behaviour was translated into design moves.
3. How the D/C orientation was decided.
4. Why the Controller did or did not intervene.
5. What guidance was delivered and when.

### 11. Current model-design decision and planned test

The current implementation follows the plan: use the fine-tuned evaluation model through `EVAL_MODEL_ID` for move-type coding, and use a separate Decision Agent for D/C orientation.

A future evaluation item has been recorded: test whether a general-purpose model, given strong coding guidance in a system prompt, can directly and reliably output both move type and D/C orientation without fine-tuning. The comparison should preserve the same event partitions and count checks, and evaluate coding quality, agreement with labels, latency, and cost before simplifying the current two-agent analytic flow.

---

## Part B. PPT-Ready Point Form

### Slide 1. Manipulation System Architecture

- Goal: adaptively guide the participant's design process during AI collaboration
- Five runtime components:
  - Event Timeline Builder
  - Evaluation Agent
  - Decision Agent
  - Deterministic Manipulation Controller
  - Main Response Agent
- Design principle: LLMs interpret behaviour; deterministic code enforces experimental rules

### Slide 2. Real-Time Data Pipeline

- Capture three streams in real time:
  - Canvas/editor interaction logs
  - Speech transcript segments
  - User and assistant chat messages
- Convert all events to a common epoch-time timeline
- On Send: flush interaction logs before saving the user message
- Build one ordered `session_events` timeline for each session

### Slide 3. Turn Construction and Event Processing

- Analytic unit: one closed user turn
- Turn boundary: after previous user message to current user message
- Includes: interaction events, speech, prior AI context, current user message
- Event Timeline Builder:
  - Removes interaction noise and duplicates
  - Merges/filter speech segments
  - Normalises and orders all events
- Final session submission also evaluates remaining tail events

### Slide 4. Evaluation Agent: Design-Move Coding

- Uses fine-tuned model configured by `EVAL_MODEL_ID`
- Outputs sequential design moves:
  - 1 Explore/interpret
  - 2 Ask AI
  - 3 Generate/propose
  - 4 Evaluate/revise
  - 5 Respond to AI output
  - 6 Externalise/execute in artefact
- Validates output and count checks for AI requests and responses
- Retries malformed or inconsistent outputs; logs all coded moves

### Slide 5. Decision Agent: D/C Orientation

- Independently labels each current turn as:
  - D: Decision-oriented
  - C: Communication-oriented
- Inputs:
  - Current event partition
  - Evaluator-coded moves
  - Prior D/C-labelled move history
- Attach one D/C decision to the latest content move (types 1, 3, 4, or 6)
- Keep all other move labels in the ledger for analysis

### Slide 6. Manipulation Controller

- Group 1: Control, no guidance
- High task manipulation:
  - Detect two consecutive same-orientation moves
  - Prompt the opposite orientation
- Low task manipulation:
  - Detect two moves away from the target orientation
  - Prompt the target orientation
- Intervention only when a policy rule fires
- Controller clears its triggering streak after intervention

### Slide 7. Guidance Delivery and Traceability

- Select a condition-specific D/C guidance template
- High vs. low task framing changes the guidance framing
- Save guidance as an assistant message with `is_guidance`
- Deliver through the existing streaming chat interface
- Store full research trace:
  - Session event timeline
  - Move ledger
  - Per-agent execution log
  - Intervention decision and guidance output

### Slide 8. Current and Future Model Strategy

- Current implementation:
  - Fine-tuned Evaluation Agent for move-type coding
  - Separate Decision Agent for D/C classification
  - Deterministic Controller for treatment policy
- Future test:
  - General-purpose model + system-prompt coding guidance
  - Directly output move type and D/C without fine-tuning
  - Compare quality, agreement, latency, and cost

