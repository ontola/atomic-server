// @vitest-environment jsdom
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useResizable, type UseResizableProps } from './useResizable';

beforeEach(() => {
  // jsdom has no native PointerEvent; retain the coordinates and pointer identity.
  class TestPointerEvent extends MouseEvent {
    pointerId: number;
    isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Fixture({
  onResize = vi.fn(),
  onClick = vi.fn(),
  ...options
}: Partial<UseResizableProps<HTMLDivElement>> & { onClick?: () => void }) {
  const targetRef = useRef<HTMLDivElement>(null);
  const { size, dragAreaListeners } = useResizable({
    targetRef,
    initialSize: 200,
    minSize: 60,
    maxSize: 400,
    edge: 'top',
    onResize,
    ...options,
  });

  return (
    <div ref={targetRef} data-testid='target' style={{ height: size }}>
      <button
        type='button'
        data-testid='handle'
        {...dragAreaListeners}
        onClick={onClick}
      >
        <span>Header</span>
      </button>
    </div>
  );
}

it('resizes with touch pointer input and stops on cancellation', () => {
  const onResize = vi.fn();
  render(<Fixture onResize={onResize} />);
  vi.spyOn(
    screen.getByTestId('target'),
    'getBoundingClientRect',
  ).mockReturnValue({
    x: 0,
    y: 20,
    top: 20,
    bottom: 220,
    left: 0,
    right: 200,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(screen.getByTestId('handle'), {
    clientY: 220,
    button: 0,
  });
  fireEvent.pointerMove(window, { clientY: 300 });
  expect(onResize).toHaveBeenLastCalledWith(280);
  fireEvent.pointerCancel(window);
  expect(document.head.textContent).not.toContain('cursor: row-resize');
  fireEvent.pointerMove(window, { clientY: 350 });
  expect(onResize).toHaveBeenCalledTimes(1);
});

it('removes active drag listeners when unmounted', () => {
  const onResize = vi.fn();
  const { unmount } = render(<Fixture onResize={onResize} />);
  fireEvent.pointerDown(screen.getByTestId('handle'), {
    clientY: 200,
    button: 0,
  });
  unmount();
  fireEvent.pointerMove(window, { clientY: 300 });
  expect(onResize).not.toHaveBeenCalled();
});

it('header dragging uses the starting height, clamps it and suppresses only the drag click', () => {
  const onResize = vi.fn();
  const onClick = vi.fn();
  render(
    <Fixture
      onResize={onResize}
      onClick={onClick}
      mode='delta'
      edge='bottom'
      threshold={6}
    />,
  );
  vi.spyOn(
    screen.getByTestId('target'),
    'getBoundingClientRect',
  ).mockReturnValue({
    x: 0,
    y: 300,
    top: 300,
    bottom: 500,
    left: 0,
    right: 200,
    width: 200,
    height: 200,
    toJSON: () => ({}),
  });
  const header = screen.getByText('Header');
  fireEvent.pointerDown(header, { clientY: 275 });
  fireEvent.pointerMove(window, { clientY: 273 });
  expect(onResize).not.toHaveBeenCalled();
  fireEvent.pointerMove(window, { clientY: 175 });
  expect(onResize).toHaveBeenLastCalledWith(300);
  // A touch initially captures the title span before the hook captures its header.
  fireEvent.lostPointerCapture(header);
  fireEvent.pointerMove(window, { clientY: 0 });
  expect(onResize).toHaveBeenLastCalledWith(400);
  fireEvent.pointerMove(window, { clientY: 600 });
  expect(onResize).toHaveBeenLastCalledWith(60);
  fireEvent.pointerUp(window);
  fireEvent.click(header, { detail: 1 });
  expect(onClick).not.toHaveBeenCalled();

  fireEvent.pointerDown(header, { clientY: 275 });
  fireEvent.pointerUp(window);
  fireEvent.click(header, { detail: 1 });
  expect(onClick).toHaveBeenCalledOnce();
});

it('ignores secondary contacts and buttons and stops resizing on blur', () => {
  const onResize = vi.fn();
  render(<Fixture onResize={onResize} />);
  const handle = screen.getByTestId('handle');
  fireEvent.pointerDown(handle, { button: 2 });
  fireEvent.pointerMove(window, { clientY: 300 });
  fireEvent.pointerDown(handle, { isPrimary: false, pointerId: 2 });
  fireEvent.pointerMove(window, { clientY: 300, pointerId: 2 });
  expect(onResize).not.toHaveBeenCalled();
  fireEvent.pointerDown(handle);
  fireEvent.pointerMove(window, { clientY: 300, pointerId: 2 });
  fireEvent.pointerUp(window, { pointerId: 2 });
  expect(onResize).not.toHaveBeenCalled();
  fireEvent.pointerMove(window, { clientY: 100 });
  expect(onResize).toHaveBeenCalledOnce();
  fireEvent.blur(window);
  fireEvent.pointerMove(window, { clientY: 200 });
  expect(onResize).toHaveBeenCalledOnce();
});
