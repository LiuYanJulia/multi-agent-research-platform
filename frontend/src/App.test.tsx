import React from 'react';
import { render, screen } from '@testing-library/react';

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

import App from './App';

test('renders the study entry screen', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: 'Welcome to the Study' })).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Enter your user ID')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Enter your group ID')).toBeInTheDocument();
});
