import { editableHtmlToMarkdown, markdownToEditableHtml } from './markdownEditor';

describe('Markdown editor conversion', () => {
  it('renders basic Markdown structures into editable HTML', () => {
    const html = markdownToEditableHtml(`**Heat plan**\n\n- Call residents\n- Open hubs\n\n| Partner | Role |\n| --- | --- |\n| Pharmacy | Check-in |`);

    expect(html).toContain('<strong>Heat plan</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<td>Pharmacy</td>');
  });

  it('serializes rich editor HTML back to Markdown text', () => {
    const markdown = editableHtmlToMarkdown('<p><strong>Heat plan</strong></p><ul><li>Call residents</li><li>Open hubs</li></ul><table><thead><tr><th>Partner</th><th>Role</th></tr></thead><tbody><tr><td>Pharmacy</td><td>Check-in</td></tr></tbody></table>');

    expect(markdown).toBe('**Heat plan**\n\n- Call residents\n- Open hubs\n\n| Partner | Role |\n| --- | --- |\n| Pharmacy | Check-in |');
  });

  it('removes unsupported executable markup while retaining readable text', () => {
    const markdown = editableHtmlToMarkdown('<p>Safe text<script>alert("no")</script></p><iframe src="https://example.com">Ignored</iframe>');

    expect(markdown).toBe('Safe text');
  });
});
