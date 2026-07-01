import React from 'react';
import { GettingStartedFlow } from './getting-started/GettingStartedFlow';

type Props = {
  /** Canonical subject for the server home (used to refetch after sign-in). */
  subject: string;
};

/**
 * Full-screen entry when the server has nothing useful at `/` (no mapped root
 * drive yet, or the user must sign in). Product pitch + sign-in card.
 */
export function RootWelcomeGate({ subject }: Props) {
  return <GettingStartedFlow subject={subject} initialStep='welcome' />;
}
