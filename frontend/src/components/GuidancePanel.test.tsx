import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import GuidancePanel, { DisplayedGuidance } from './GuidancePanel';

const guidance = (id: string): DisplayedGuidance => ({
  id,
  content: `Guidance response ${id}`,
  displaySummary: `[Exploration] Guidance ${id}`,
  timestamp: new Date(`2026-10-29T00:00:0${id}.000Z`),
  messageIndex: Number(id),
});

describe('GuidancePanel', () => {
  it('keeps a visible empty guidance box before any proactive guidance arrives', () => {
    render(<GuidancePanel guidance={[]} />);

    expect(screen.getByRole('heading', { name: 'AI Guidance' })).toBeInTheDocument();
    expect(screen.getByText('Proactive AI guidance will be shown here. Please consider them into your own thinking')).toBeInTheDocument();
    expect(screen.getByTestId('guidance-panel-container')).toHaveStyle({ backgroundColor: '#ffffff' });
  });

  it('shows only the three newest guidance cards and flashes the newest delivery five times', () => {
    render(<GuidancePanel guidance={['1', '2', '3', '4'].map(guidance)} newlyDeliveredId="4" />);

    expect(screen.queryByText('Guidance response 1')).not.toBeInTheDocument();
    expect(screen.getByText('Guidance response 2')).toBeInTheDocument();
    expect(screen.getByText('Guidance response 3')).toBeInTheDocument();
    expect(screen.getByText('Guidance response 4')).toBeInTheDocument();
    expect(screen.getByTestId('guidance-card-4')).toHaveClass('guidance-panel-flash-five');
  });

  it('marks guidance with its raw section and sequential message ID for interaction logging', () => {
    render(<GuidancePanel guidance={[guidance('7')]} />);

    expect(screen.getByTestId('guidance-panel-container')).toHaveAttribute('data-interaction-section', 'guidance');
    expect(screen.getByTestId('guidance-card-7')).toHaveAttribute('data-interaction-section', 'guidance');
    expect(screen.getByTestId('guidance-card-7')).toHaveAttribute('data-message-index', '7');
  });
});
