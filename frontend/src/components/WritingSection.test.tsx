import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import WritingSection from './WritingSection';

const logger = { logEvent: jest.fn(), sendBatch: jest.fn() };

describe('WritingSection rich Markdown editor', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: jest.fn() });
  });

  it('uses an always-visible rich text editor without a formatting toolbar', () => {
    render(<WritingSection logger={logger} isPracticeMode />);

    expect(screen.getByTestId('writing-rich-editor')).toHaveAttribute('contenteditable', 'true');
    expect(screen.queryByRole('button', { name: 'Bold' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Bulleted list' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Insert table' })).not.toBeInTheDocument();
  });

  it('clears the rich editor and its Markdown state together', () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    render(<WritingSection logger={logger} isPracticeMode />);
    const editor = screen.getByTestId('writing-rich-editor');
    editor.innerHTML = '<p><strong>Heat plan</strong></p>';
    fireEvent.input(editor);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(editor).toHaveTextContent('');
  });
});
