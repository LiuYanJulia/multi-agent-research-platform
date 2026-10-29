import React from 'react';
import { render, screen } from '@testing-library/react';
import WebRTCTranscript from './WebRTCTranscript';

test('renders its connection status in compact mode for placement above the chat', () => {
  render(<WebRTCTranscript sessionId="test-session" compactStatus />);

  expect(screen.getByTestId('realtime-status-compact')).toHaveTextContent('Disconnected');
});
