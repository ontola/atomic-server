import { expect, it } from 'vitest';
import {
  closeOverlay,
  openSearchOverlay,
  pendingSearchOverlayQuery,
  setOverlay,
} from './overlayState';

it('opens search with a query, and forgets it once closed', () => {
  openSearchOverlay('content plan');
  expect(pendingSearchOverlayQuery()).toBe('content plan');

  closeOverlay();
  expect(pendingSearchOverlayQuery()).toBe('');

  // The keyboard shortcut opens it directly: it must start empty.
  setOverlay('search');
  expect(pendingSearchOverlayQuery()).toBe('');
});

it('starts empty when opened without a query after one with', () => {
  openSearchOverlay('content plan');
  openSearchOverlay();
  expect(pendingSearchOverlayQuery()).toBe('');
});
