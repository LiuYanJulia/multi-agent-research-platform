import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import WritingSection from './WritingSection';

const logger = { logEvent: jest.fn(), sendBatch: jest.fn() };

describe('WritingSection rich Markdown editor', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'execCommand', { configurable: true, value: jest.fn() });
  });

  it('uses an always-visible rich text editor with a bold control', () => {
    render(<WritingSection logger={logger} isPracticeMode />);

    expect(screen.getByTestId('writing-rich-editor')).toHaveAttribute('contenteditable', 'true');
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Bold' }));
    expect(document.execCommand).toHaveBeenCalledWith('bold');
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
