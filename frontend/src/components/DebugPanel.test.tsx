import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import DebugPanel, { AgentStageEvent } from './DebugPanel';

describe('DebugPanel guidance auditing', () => {
  it('keeps the full guidance context available behind an expander', () => {
    const stages: AgentStageEvent[] = [{
      agent: 'main_response_agent',
      status: 'completed',
      timestamp: 1,
      guidanceCard: {
        displaySummary: 'Based on your 2 earlier ideas, AI provides 2 ideas for you to consider.',
        directionGuidance: 'Explore two nearby design variations.',
        previousIdeas: ['peer mentoring', 'skill tracker'],
        response: 'First, refine the mentoring loop.\n\n1. Add a shared progress view.',
      },
    }];

    render(<DebugPanel isTestUser isPracticeSession={false} transcript={[]} partialTranscript={null} stages={stages} />);

    fireEvent.click(screen.getByRole('button', { name: /debug/i }));
    fireEvent.click(screen.getByRole('button', { name: /full ai guidance card context/i }));

    expect(screen.getByText('Explore two nearby design variations.')).toBeInTheDocument();
    expect(screen.getByText('peer mentoring, skill tracker')).toBeInTheDocument();
    expect(screen.getByText(/First, refine the mentoring loop/)).toBeInTheDocument();
  });

  it('shows the private planner output behind its own expander', () => {
    const stages: AgentStageEvent[] = [{
      agent: 'main_response_agent', status: 'completed', timestamp: 1,
      guidancePlannerOutput: {
        directionGuidance: 'Connect cooling-hub check-ins to pharmacy refill visits.',
        previousIdeas: ['neighbour check-ins', 'pharmacy partners'],
        writingContextSummary: 'The participant has proposed neighbourhood heat alerts.',
      },
    }];
    render(<DebugPanel isTestUser isPracticeSession={false} transcript={[]} partialTranscript={null} stages={stages} />);
    fireEvent.click(screen.getByRole('button', { name: /debug/i }));
    fireEvent.click(screen.getByRole('button', { name: /guidance planner output/i }));
    expect(screen.getByText(/cooling-hub check-ins/)).toBeInTheDocument();
    expect(screen.getByText(/writingContextSummary/)).toBeInTheDocument();
  });
});
