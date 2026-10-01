// @wc-ignore-file
/**
 * Checks what an app asks the host to draw.
 *
 * Everything here comes from a frame we do not trust, and the host renders it
 * in its own UI, so it is bounded before it gets near a component: short
 * labels, a capped item count, and positions that stay over the frame. A menu
 * that could open anywhere on the page could pass itself off as the host's own.
 */

import { Client } from '@tomic/react';
import type { ViewKeyEvent } from '@tomic/plugin';

const MAX_LABEL = 80;
const MAX_TEXT = 400;
const MAX_ITEMS = 50;
const MAX_ID = 64;

export interface ConfirmAsk {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger: boolean;
}

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastAsk {
  text: string;
  kind: ToastKind;
}

export type MenuEntry =
  | 'divider'
  | { id: string; label: string; disabled: boolean };

export interface MenuAsk {
  at: Point;
  items: MenuEntry[];
}

export interface Point {
  x: number;
  y: number;
}

/** The parts of a frame's bounding rect this file needs. */
export interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

type Args = Record<string, unknown>;

export function parseConfirm(args: Args): ConfirmAsk {
  return {
    title: requiredText(args.title, 'title', MAX_LABEL),
    body: optionalText(args.body, 'body', MAX_TEXT),
    confirmLabel: optionalText(args.confirmLabel, 'confirmLabel', MAX_LABEL),
    danger: args.danger === true,
  };
}

export function parseToast(args: Args): ToastAsk {
  const kind = args.kind ?? 'info';

  if (kind !== 'success' && kind !== 'error' && kind !== 'info') {
    throw new Error('kind must be success, error or info');
  }

  return { text: requiredText(args.text, 'text', MAX_TEXT), kind };
}

export function parseMenu(args: Args): MenuAsk {
  if (!Array.isArray(args.items) || args.items.length === 0) {
    throw new Error('items must be a non-empty list');
  }

  if (args.items.length > MAX_ITEMS) {
    throw new Error(`a menu holds at most ${MAX_ITEMS} items`);
  }

  const seen = new Set<string>();
  const items = args.items.map((item: unknown): MenuEntry => {
    if (item === 'divider') return 'divider';

    if (!item || typeof item !== 'object') {
      throw new Error('each item is "divider" or { id, label }');
    }

    const { id, label, disabled } = item as Args;
    const checkedId = requiredText(id, 'id', MAX_ID);

    if (seen.has(checkedId)) throw new Error(`duplicate item id: ${checkedId}`);
    seen.add(checkedId);

    return {
      id: checkedId,
      label: requiredText(label, 'label', MAX_LABEL),
      disabled: disabled === true,
    };
  });

  return { at: parsePoint(args.at), items };
}

/** `at` is a point in the frame's own coordinates. */
export function parsePoint(value: unknown): Point {
  if (!value || typeof value !== 'object') {
    throw new Error("at must be { x, y } in the frame's coordinates");
  }

  const { x, y } = value as Args;

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("at must be { x, y } in the frame's coordinates");
  }

  return { x: x as number, y: y as number };
}

export function parseSubject(args: Args): string {
  const subject = requiredText(args.subject, 'subject', 2048);

  if (!Client.isValidSubject(subject)) {
    throw new Error(`not a valid subject: ${subject}`);
  }

  return subject;
}

/**
 * Turns a point in the frame into a point on the page, kept inside the frame.
 * The menu itself may still extend past the frame's edge, which is the point
 * of the host drawing it; where it is anchored may not.
 */
export function placeInFrame(at: Point, frame: FrameRect): Point {
  const x = Math.min(Math.max(at.x, 0), frame.width);
  const y = Math.min(Math.max(at.y, 0), frame.height);

  return { x: frame.left + x, y: frame.top + y };
}

/**
 * Keys a frame should pass up. Plain typing never leaves the frame, and the
 * editing shortcuts a text field already handles (copy, paste, undo, select
 * all) stay with it: forwarding those would make the host undo its own last
 * change while the person meant the text they are typing.
 */
export function shouldForwardKey(event: ViewKeyEvent): boolean {
  if (event.key === 'Escape') return true;

  const modifier = event.ctrlKey || event.metaKey || event.altKey;

  if (!modifier) return false;

  return !EDITING_KEYS.has(event.key.toLowerCase());
}

const EDITING_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

function requiredText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} is required`);
  }

  if (value.length > max) {
    throw new Error(`${name} is longer than ${max} characters`);
  }

  return value;
}

function optionalText(
  value: unknown,
  name: string,
  max: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  return requiredText(value, name, max);
}
