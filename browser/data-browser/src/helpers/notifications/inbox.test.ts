import { describe, expect, it } from 'vitest';
import { notifications, type Resource } from '@tomic/react';
import { dedupeBySource, isUnread } from './inbox';

const fake = (
  subject: string,
  props: { source?: string; at?: number; readAt?: number },
) =>
  ({
    subject,
    get: (prop: string) =>
      ({
        [notifications.properties.notificationSource]: props.source,
        [notifications.properties.occurredAt]: props.at,
        [notifications.properties.readAt]: props.readAt,
      })[prop],
    getCreatedAt: () => undefined,
  }) as unknown as Resource;

describe('dedupeBySource', () => {
  it('sorts newest first', () => {
    const list = dedupeBySource([
      fake('a', { source: 'm1', at: 1 }),
      fake('b', { source: 'm2', at: 3 }),
      fake('c', { source: 'm3', at: 2 }),
    ]);

    expect(list.map(n => n.subject)).toEqual(['b', 'c', 'a']);
  });

  it('shows one item per source, read if any copy is', () => {
    const list = dedupeBySource([
      fake('phone', { source: 'm1', at: 1 }),
      fake('laptop', { source: 'm1', at: 1, readAt: 5 }),
      fake('other', { source: 'm2', at: 2 }),
    ]);

    expect(list.map(n => n.subject)).toEqual(['other', 'laptop']);
    expect(isUnread(list[1])).toBe(false);
  });
});
