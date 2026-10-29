# WYSIWYG Markdown Writing Design

## Intent

Make the participant writing area continuously display Markdown as formatted content while preserving the study's existing plain-text persistence and exports.

## Approved behavior

- Replace the visible `textarea` with an always-on rich-text editing surface. There is no Edit/Preview toggle.
- Markdown lists, numbered lists, bold text, and GFM-style tables pasted from an AI response display as their rendered structures in the editor.
- Basic formatting actions are available in the editor: Cmd/Ctrl+B for bold, plus compact buttons for bold, bulleted list, numbered list, and table insertion.
- The canonical React `content` value remains Markdown text. Every edit is serialized to Markdown before the existing autosave and submit flows use it.
- `writing_drafts.content`, `writing_snapshots.content`, `finalWriting`, word counts, character counts, API routes, database schema, and submission exports remain unchanged.
- Existing draft text is converted to the editor display when the editor receives content programmatically (for example, Clear).

## Chosen approach

Use a local `contentEditable` editor plus tested conversion helpers in the frontend. The helpers render the supported Markdown subset into safe editable HTML and serialize editable HTML back to Markdown. This keeps the backend contract exactly as it is and avoids a heavy editor dependency for the study platform.

## Scope limits

- Support the requested Markdown structures: paragraphs, bold, italic, unordered and ordered lists, and pipe tables.
- Preserve unsupported pasted content as readable plain text rather than attempting lossless document conversion.
- Do not add a Markdown source mode, collaborative editing, images, links, code blocks, or backend migrations.
