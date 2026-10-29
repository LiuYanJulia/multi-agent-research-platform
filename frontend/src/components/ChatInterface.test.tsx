import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TextDecoder } from 'util';

// react-markdown ships as ESM while this Create React App Jest setup does not
// transform it. The streaming behavior only needs its rendered children.
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import ChatInterface from './ChatInterface';

Object.defineProperty(global, 'TextDecoder', { configurable: true, value: TextDecoder });

function streamResponse(parts: Array<Record<string, unknown>>) {
  let index = 0;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () => {
          if (index === parts.length) return { done: true, value: undefined };
          const value = new Uint8Array(
            Array.from(`data: ${JSON.stringify(parts[index])}\n`, (character) => character.charCodeAt(0)),
          );
          index += 1;
          return { done: false, value };
        },
      }),
    },
  } as Response;
}

describe('ChatInterface streaming', () => {
  let historyMessages: Array<Record<string, unknown>>;

  const logger = {
    logEvent: jest.fn(),
    sendBatch: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    historyMessages = [];
    global.fetch = jest.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/chat/history')) {
        return Promise.resolve({ ok: true, json: async () => ({ messages: historyMessages }) } as Response);
      }
      if (url.includes('/api/chat/model-info')) {
        return Promise.resolve({ ok: true, json: async () => ({ model: 'test-model' }) } as Response);
      }
      if (url.includes('/api/chat/stream')) {
        return Promise.resolve(streamResponse([
          { content: 'First part. ' },
          { content: 'Second part. ' },
          { content: 'Third part.' },
          { done: true },
        ]));
      }
      if (url.includes('/api/chat/save-message')) {
        return Promise.resolve({ ok: true } as Response);
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as jest.Mock;
  });

  it('scrolls only once while one AI response streams in multiple parts', async () => {
    render(<ChatInterface sessionId="" sessionStartTime={0} logger={logger} />);

    const container = document.querySelector('[data-interaction-section="response"]') as HTMLDivElement;
    const scrollTo = jest.fn();
    Object.defineProperty(container, 'scrollTo', { configurable: true, value: scrollTo });

    fireEvent.change(screen.getByPlaceholderText('Ask anything'), { target: { value: 'Hello' } });
    fireEvent.submit(document.querySelector('form[data-type="unified-composer"]')!);

    await screen.findByText('First part. Second part. Third part.');

    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
  });

  it('reports delivered guidance to the page without rendering it in the chat stream', async () => {
    historyMessages = [{
      messageId: 'guidance-1',
      role: 'ai_guidance',
      content: 'Start with one concise direction, then develop the key details.',
      timestamp: '2026-10-29T00:00:00.000Z',
      guidanceDirection: 'Explore two nearby design variations.',
      guidancePreviousIdeas: ['peer mentoring', 'skill tracker'],
      guidanceDisplaySummary: '[Exploration] Based on your 2 earlier ideas, AI provides 2 ideas for you to consider.',
    }];

    const onGuidanceChange = jest.fn();
    render(<ChatInterface sessionId="guidance-session" sessionStartTime={0} logger={logger} onGuidanceChange={onGuidanceChange} />);

    await waitFor(() => expect(onGuidanceChange).toHaveBeenLastCalledWith([
      expect.objectContaining({
        id: 'guidance-1',
        displaySummary: '[Exploration] Based on your 2 earlier ideas, AI provides 2 ideas for you to consider.',
        content: 'Start with one concise direction, then develop the key details.',
      }),
    ]));
    expect(screen.queryByText('[Exploration] Based on your 2 earlier ideas, AI provides 2 ideas for you to consider.')).not.toBeInTheDocument();
    expect(screen.queryByText('Start with one concise direction, then develop the key details.')).not.toBeInTheDocument();
    expect(screen.queryByText('Explore two nearby design variations.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Your earlier ideas: peer mentoring, skill tracker/)).not.toBeInTheDocument();
  });
});
