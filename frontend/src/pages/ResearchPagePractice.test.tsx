import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import ResearchPagePractice from './ResearchPagePractice';

jest.mock('../components/Timer', () => ({ onExpire }: { onExpire: () => void }) => (
  <button type="button" onClick={onExpire}>End practice</button>
));
jest.mock('../components/ChatInterface', () => () => <div />);
jest.mock('../components/GuidancePanel', () => () => <div />);
jest.mock('../components/WritingSection', () => () => <div />);
jest.mock('../components/WebRTCTranscript', () => {
  const React = require('react');
  return React.forwardRef((_props: unknown, ref: React.Ref<unknown>) => {
    React.useImperativeHandle(ref, () => ({ startRecording: jest.fn(), stopRecording: jest.fn() }));
    return <div />;
  });
});
jest.mock('../hooks/useInteractionLogger', () => ({
  useInteractionLogger: () => ({ logEvent: jest.fn(), sendBatch: jest.fn().mockResolvedValue(undefined) }),
}));

test('shows a Debug button for any participant only after the practice-complete password modal opens', () => {
  render(
    <ResearchPagePractice
      sessionId="practice_participant_1"
      sessionStartTime={Date.now()}
      userId="participant_1"
      groupId="1"
      onComplete={jest.fn()}
    />,
  );

  expect(screen.queryByRole('button', { name: 'Open debug panel' })).not.toBeInTheDocument();
  expect(screen.queryByTitle('Test mode debug panel')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'End practice' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open debug panel' }));

  expect(screen.getByText('Test Mode Debug Panel')).toBeInTheDocument();
});
