import React from 'react';
import { render, screen } from '@testing-library/react';
import WelcomeActual from './WelcomeActual';

test('states that the actual task must reuse existing resources instead of building major cooling infrastructure', () => {
  render(<WelcomeActual groupId="1" onStart={jest.fn()} />);

  expect(screen.getByText(/cannot build major new cooling infrastructure/i)).toBeInTheDocument();
  expect(screen.getByText(/creatively reorganise existing spaces, services, resources, relationships, and routines/i)).toBeInTheDocument();
  expect(screen.getByText(/care, work, travel, rest, and access to services/i)).toBeInTheDocument();
});
