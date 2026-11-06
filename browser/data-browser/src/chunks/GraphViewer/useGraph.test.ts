// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Resource } from '@tomic/react';
import { useGraph } from './useGraph';

const state = vi.hoisted(() => ({
  positions: {} as Record<string, [number, number]>,
  save: vi.fn(),
}));

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useValue: () => [state.positions, state.save],
}));
vi.mock('styled-components', async importOriginal => ({
  ...(await importOriginal<typeof import('styled-components')>()),
  useTheme: () => ({ colors: { bg: '#fff', bg2: '#ddd', text: '#000' } }),
}));

beforeEach(() => {
  state.positions = {};
  state.save.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

it('accepts the initial position notification without a preceding drag', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  expect(() =>
    act(() =>
      result.current.handleNodeChange([
        { id: 'note', type: 'position', position: { x: 20, y: 30 } },
      ]),
    ),
  ).not.toThrow();
  expect(state.save).not.toHaveBeenCalled();
});

it('accepts a stop without coordinates when no drag has started', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() =>
    result.current.handleNodeChange([
      { id: 'note', type: 'position', dragging: false },
    ]),
  );
  expect(state.save).not.toHaveBeenCalled();
});

it('persists a keyboard move from its own coordinates, preserving other saved nodes', () => {
  state.positions = { other: [90, 80] };
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() =>
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: false,
        position: { x: 0, y: -30 },
      },
    ]),
  );
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    other: [90, 80],
    note: [0, -30],
  });
});

it('retains the latest drag coordinates when start and stop arrive before a render', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() => {
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: true,
        position: { x: 10, y: 20 },
      },
    ]);
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: true,
        position: { x: 30, y: 40 },
      },
    ]);
    expect(state.save).not.toHaveBeenCalled();
    result.current.handleNodeChange([
      { id: 'note', type: 'position', dragging: false },
    ]);
  });
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ note: [30, 40] });
});

it('processes every node in a batch without mixing their drag positions', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() =>
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'dimensions',
        dimensions: { width: 100, height: 100 },
      },
      {
        id: 'note',
        type: 'position',
        dragging: true,
        position: { x: 10, y: 20 },
      },
      {
        id: 'item',
        type: 'position',
        dragging: true,
        position: { x: 30, y: 40 },
      },
      { id: 'item', type: 'position', dragging: false },
      { id: 'note', type: 'position', dragging: false },
    ]),
  );
  expect(state.save).toHaveBeenCalledExactlyOnceWith({
    note: [10, 20],
    item: [30, 40],
  });
});

it('uses the final coordinates when a stop carries a newer position', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() => {
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: true,
        position: { x: 10, y: 20 },
      },
    ]);
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: false,
        positionAbsolute: { x: 50, y: 60 },
      },
    ]);
  });
  expect(state.save).toHaveBeenCalledExactlyOnceWith({ note: [50, 60] });
});

it('does not persist non-finite coordinates', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  act(() =>
    result.current.handleNodeChange([
      {
        id: 'note',
        type: 'position',
        dragging: false,
        position: { x: Number.NaN, y: Infinity },
      },
    ]),
  );
  expect(state.save).not.toHaveBeenCalled();
});

it('accepts an empty change batch', () => {
  const { result } = renderHook(() => useGraph({} as Resource));
  expect(() => act(() => result.current.handleNodeChange([]))).not.toThrow();
  expect(state.save).not.toHaveBeenCalled();
});
