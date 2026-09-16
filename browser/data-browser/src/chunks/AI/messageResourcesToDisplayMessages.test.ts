import { describe, expect, it } from 'vitest';
import { ai } from '@tomic/react';
import type { Store } from '@tomic/react';
import { messageResourcesToDisplayMessages } from './chatConversionUtils';

const USER_TAG = 'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/user';
const ASSISTANT_TAG =
  'https://atomicdata.dev/01jtjxtsa9syxmfca2zx5gcnmj/tag/assistant';

interface FakeResource {
  subject: string;
  error?: Error;
  props: Record<string, unknown>;
  get: (property: string) => unknown;
  hasClasses: (...classes: string[]) => boolean;
  getClasses: () => string[];
}

const message = (
  subject: string,
  role: string,
  parts: string[],
): FakeResource => ({
  subject,
  props: { role, parts },
  get: () => undefined,
  hasClasses: () => false,
  getClasses: () => [ai.classes.aiMessage],
});

const textPart = (subject: string, text: string): FakeResource => ({
  subject,
  props: { description: text },
  get: () => undefined,
  hasClasses: (...classes: string[]) => classes.includes(ai.classes.textPart),
  getClasses: () => [ai.classes.textPart],
});

/** A store whose fetches resolve only when the test says so. */
function deferredStore(resources: FakeResource[]) {
  const bySubject = new Map(resources.map(r => [r.subject, r]));
  const requested: string[] = [];
  const pending = new Map<string, (resource: FakeResource) => void>();

  const getResource = (subject: string) => {
    requested.push(subject);

    return new Promise<FakeResource>(resolve => {
      pending.set(subject, resolve);
    });
  };

  const store = {
    getResource,
    getResources: (subjects: string[]) =>
      Promise.all(subjects.map(getResource)),
  } as unknown as Store;

  const resolve = (subjects: string[]) => {
    for (const subject of subjects) {
      pending.get(subject)!(bySubject.get(subject)!);
      pending.delete(subject);
    }
  };

  const settle = () => new Promise(r => setTimeout(r, 0));

  return { store, requested, resolve, settle };
}

describe('messageResourcesToDisplayMessages', () => {
  it('fetches every part of every message in one round after the messages', async () => {
    const { store, requested, resolve, settle } = deferredStore([
      message('m1', USER_TAG, ['p1']),
      message('m2', ASSISTANT_TAG, ['p2', 'p3']),
      textPart('p1', 'Hello'),
      textPart('p2', 'Hi'),
      textPart('p3', 'there'),
    ]);

    const result = messageResourcesToDisplayMessages(['m1', 'm2'], store);
    await settle();
    expect(requested).toEqual(['m1', 'm2']);

    resolve(['m1', 'm2']);
    await settle();
    // All parts are in flight together: no part waits for another message.
    expect(requested.slice(2).sort()).toEqual(['p1', 'p2', 'p3']);

    resolve(['p1', 'p2', 'p3']);
    const map = await result;
    const texts = Array.from(map.keys()).map(m =>
      m.parts.map(p => (p.type === 'text' ? p.text : p.type)),
    );
    expect(texts).toEqual([['Hello'], ['Hi', 'there']]);
  });
});
