const escapeHtml = (value: string) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const tableCells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
const tableDivider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+?)\*/g, '<em>$1</em>')
    .replace(/_([^_]+?)_/g, '<em>$1</em>');
}

/** Converts the supported plain-text Markdown subset into safe rich-editor HTML. */
export function markdownToEditableHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].trim()) { index += 1; continue; }
    if (lines[index].includes('|') && tableDivider(lines[index + 1] ?? '')) {
      const header = tableCells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      blocks.push(`<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${inlineMarkdownToHtml(row[cellIndex] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(lines[index]);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(lines[index]);
    if (unordered || ordered) {
      const isOrdered = Boolean(ordered);
      const values: string[] = [];
      while (index < lines.length) {
        const match = (isOrdered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/).exec(lines[index]);
        if (!match) break;
        values.push(match[1]);
        index += 1;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      blocks.push(`<${tag}>${values.map((value) => `<li>${inlineMarkdownToHtml(value)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !(/^\s*[-*+]\s+/.test(lines[index]) || /^\s*\d+[.)]\s+/.test(lines[index]) || (lines[index].includes('|') && tableDivider(lines[index + 1] ?? '')))) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(`<p>${paragraph.map(inlineMarkdownToHtml).join('<br>')}</p>`);
  }
  return blocks.join('') || '<p><br></p>';
}

function inlineHtmlToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (!(node instanceof HTMLElement)) return '';
  const content = Array.from(node.childNodes).map(inlineHtmlToMarkdown).join('');
  if (node.tagName === 'STRONG' || node.tagName === 'B') return `**${content.trim()}**`;
  if (node.tagName === 'EM' || node.tagName === 'I') return `*${content.trim()}*`;
  if (node.tagName === 'BR') return '\n';
  return content;
}

function tableToMarkdown(table: HTMLTableElement): string {
  const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) => inlineHtmlToMarkdown(cell).replace(/\|/g, '\\|').trim())
  ).filter((row) => row.length > 0);
  if (!rows.length) return '';
  const width = rows[0].length;
  const normalize = (row: string[]) => Array.from({ length: width }, (_, index) => row[index] ?? '');
  return [
    `| ${normalize(rows[0]).join(' | ')} |`,
    `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
    ...rows.slice(1).map((row) => `| ${normalize(row).join(' | ')} |`),
  ].join('\n');
}

function blockHtmlToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? '').trim();
  if (!(node instanceof HTMLElement)) return '';
  if (node.tagName === 'TABLE') return tableToMarkdown(node as HTMLTableElement);
  if (node.tagName === 'UL' || node.tagName === 'OL') {
    return Array.from(node.children).filter((child) => child.tagName === 'LI').map((item, index) =>
      `${node.tagName === 'OL' ? `${index + 1}.` : '-'} ${inlineHtmlToMarkdown(item).trim()}`
    ).join('\n');
  }
  if (node.tagName === 'P' || node.tagName === 'DIV' || /^H[1-6]$/.test(node.tagName)) return inlineHtmlToMarkdown(node).trim();
  return Array.from(node.childNodes).map(blockHtmlToMarkdown).filter(Boolean).join('\n\n');
}

/** Serializes rich-editor DOM content to the Markdown text used by existing persistence. */
export function editableHtmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  document.querySelectorAll('script, style, iframe, object, embed').forEach((element) => element.remove());
  return Array.from(document.body.childNodes)
    .map(blockHtmlToMarkdown)
    .filter(Boolean)
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
