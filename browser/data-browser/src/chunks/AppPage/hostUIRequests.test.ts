import { describe, expect, it } from 'vitest';
import {
  parseConfirm,
  parseMenu,
  parseSubject,
  parseToast,
  placeInFrame,
  shouldForwardKey,
} from './hostUIRequests';

const key = (change: Record<string, unknown>) => ({
  type: 'atomic.view.key' as const,
  version: 1 as const,
  key: 'k',
  code: 'KeyK',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...change,
});

describe('what an app may ask the host to draw', () => {
  it('needs a title for a confirm and bounds its text', () => {
    expect(parseConfirm({ title: 'Delete row?', danger: true })).toEqual({
      title: 'Delete row?',
      body: undefined,
      confirmLabel: undefined,
      danger: true,
    });
    expect(() => parseConfirm({})).toThrow('title is required');
    expect(() => parseConfirm({ title: 'x'.repeat(81) })).toThrow(
      'longer than 80',
    );
    expect(parseConfirm({ title: 'Go', danger: 'yes' }).danger).toBe(false);
  });

  it('knows three kinds of toast', () => {
    expect(parseToast({ text: 'Saved' })).toEqual({
      text: 'Saved',
      kind: 'info',
    });
    expect(() => parseToast({ text: 'Saved', kind: 'sudo' })).toThrow('kind');
  });

  it('takes a bounded menu with unique ids', () => {
    const menu = parseMenu({
      at: { x: 1, y: 2 },
      items: [{ id: 'a', label: 'A' }, 'divider', { id: 'b', label: 'B' }],
    });
    expect(menu.items).toEqual([
      { id: 'a', label: 'A', disabled: false },
      'divider',
      { id: 'b', label: 'B', disabled: false },
    ]);
    expect(() => parseMenu({ at: { x: 0, y: 0 }, items: [] })).toThrow(
      'non-empty',
    );
    expect(() =>
      parseMenu({
        at: { x: 0, y: 0 },
        items: [
          { id: 'a', label: 'A' },
          { id: 'a', label: 'Again' },
        ],
      }),
    ).toThrow('duplicate');
    expect(() =>
      parseMenu({
        at: { x: 0, y: 0 },
        items: Array.from({ length: 51 }, (_, i) => ({
          id: `${i}`,
          label: 'x',
        })),
      }),
    ).toThrow('at most 50');
    expect(() =>
      parseMenu({ at: { x: NaN, y: 0 }, items: [{ id: 'a', label: 'A' }] }),
    ).toThrow('at must be');
  });

  it('refuses a subject that is not one', () => {
    expect(parseSubject({ subject: 'https://example.com/a' })).toBe(
      'https://example.com/a',
    );
    expect(() => parseSubject({ subject: 'javascript:alert(1)' })).toThrow(
      'not a valid subject',
    );
  });
});

describe('placeInFrame', () => {
  const frame = { left: 100, top: 50, width: 400, height: 300 };

  it('moves a point in the frame onto the page', () => {
    expect(placeInFrame({ x: 10, y: 20 }, frame)).toEqual({ x: 110, y: 70 });
  });

  it('keeps the anchor over the frame, so a menu cannot open over host UI', () => {
    expect(placeInFrame({ x: -500, y: 9999 }, frame)).toEqual({
      x: 100,
      y: 350,
    });
  });
});

describe('shouldForwardKey', () => {
  it('passes Escape and modified keys up', () => {
    expect(shouldForwardKey(key({ key: 'Escape' }))).toBe(true);
    expect(shouldForwardKey(key({ ctrlKey: true }))).toBe(true);
    expect(shouldForwardKey(key({ metaKey: true, key: '/' }))).toBe(true);
  });

  it('keeps typing and text editing in the frame', () => {
    expect(shouldForwardKey(key({}))).toBe(false);
    expect(shouldForwardKey(key({ shiftKey: true }))).toBe(false);

    for (const editing of ['a', 'c', 'v', 'x', 'z', 'y', 'Z'])
      expect(shouldForwardKey(key({ metaKey: true, key: editing }))).toBe(
        false,
      );
  });
});
