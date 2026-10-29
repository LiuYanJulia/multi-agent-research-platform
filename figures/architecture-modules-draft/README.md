# Real-time analysis architecture modules

Every `.svg` has a transparent canvas and no arrows or connector lines. They are intended to be inserted and arranged independently in presentation software.

Colour semantics follow the Project 3 reference modules:

- blue: captured data and LLM analysis
- orange: deterministic experimental policy
- green: stored output and delivery
- purple: optional independent D/C-orientation experiment
- yellow diamond: decision point

The Decision Agent module is explicitly optional. The default platform route maps Evaluation Agent move types to D/C orientation; the separate Decision Agent is retained for an experimental comparison.
