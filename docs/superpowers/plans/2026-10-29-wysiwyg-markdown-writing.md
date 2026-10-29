# WYSIWYG Markdown Writing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the writing area a persistent rich-text Markdown editor without changing its plain-text persistence contract.

**Architecture:** A new frontend helper converts supported Markdown into editable HTML and serializes the edited DOM back to Markdown. `WritingSection` owns the rich-text surface, sends that Markdown string through its unchanged autosave/submission state, and exposes compact formatting controls.

**Tech Stack:** React, TypeScript, DOM APIs, React Testing Library, Jest.

**Spec:** `docs/superpowers/specs/2026-10-29-wysiwyg-markdown-writing-design.md`

## Global Constraints

- Backend APIs, database schema, snapshots, and submission exports remain unchanged.
- `content` remains canonical Markdown plain text for autosave, snapshots, counts, and submission.
- Support paragraphs, bold, italic, ordered/unordered lists, and pipe tables.
- Use no Edit/Preview toggle and no new editor dependency.

## Review Focus

- A pasted HTML table serializes to a readable pipe table and re-renders as a table.
- Cmd/Ctrl+B and the toolbar change the visible selection without losing the Markdown state.
- Clearing the draft clears both editor DOM and persisted Markdown value.
- Unsupported pasted markup becomes safe readable text, never executable markup.
- Existing autosave and submission payloads retain the Markdown string rather than HTML.

---

### Task 1: Markdown/editable-HTML conversion helpers

**Files:**
- Create: `frontend/src/components/markdownEditor.ts`
- Create: `frontend/src/components/markdownEditor.test.ts`

**Interfaces:**
- Produces: `markdownToEditableHtml(markdown: string): string` and `editableHtmlToMarkdown(html: string): string`.

- [x] Write failing conversion tests for bold, lists, a pipe table, and unsupported tags.
- [x] Run `CI=true npm test -- --watch=false --runInBand markdownEditor.test.ts`; expect failing imports.
- [x] Implement safe conversions for the supported Markdown subset and readable fallback text.
- [x] Re-run the focused test; expect pass.
- [x] Commit the helper and test with the writing surface.

### Task 2: Persistent rich-text writing surface

**Files:**
- Modify: `frontend/src/components/WritingSection.tsx`
- Test: `frontend/src/components/WritingSection.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `markdownToEditableHtml` and `editableHtmlToMarkdown` from Task 1.
- Produces: unchanged `content: string` passed into existing autosave and submission flows.

- [x] Write failing component tests for rich editor controls and Clear resetting the editor.
- [x] Run the focused component test; expect failures because the textarea remains.
- [x] Replace the textarea with a controlled `contentEditable` surface; on input and paste update `content` through the serializer, and add compact bold/list/table controls including Cmd/Ctrl+B.
- [x] Re-run the focused component test; expect pass.
- [x] Commit the component and test with the conversion helper.

### Task 3: Regression verification

**Files:**
- Modify: `docs/superpowers/plans/2026-10-29-wysiwyg-markdown-writing.md`

- [x] Run `CI=true npm test -- --watch=false --runInBand` from `frontend`.
- [x] Run `npx tsc --noEmit` from `frontend` and `git diff --check` from repository root.
- [x] Mark completed tasks and commit the plan status.
