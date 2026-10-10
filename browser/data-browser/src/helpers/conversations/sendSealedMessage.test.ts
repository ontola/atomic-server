import { describe, expect, it, vi } from 'vitest';
import type { Resource, Store } from '@tomic/react';
import { MAX_ATTACHMENT_BYTES } from './attachments';
import { sendSealedMessage } from './conversations';

/** A store that fails the test if anything is created before the caps are
 *  checked: nothing may be encrypted, signed or saved for a refused message. */
function untouchedStore() {
  const newResource = vi.fn();
  const getClientDb = vi.fn();
  const store = {
    getAgent: () => ({ subject: 'did:ad:agent:me' }),
    newResource,
    getClientDb,
  } as unknown as Store;

  return { store, newResource, getClientDb };
}

const conversation = {
  subject: 'did:ad:conversation',
  get: () => '{"format":1,"epochs":[]}',
} as unknown as Resource;

const file = (size: number, name = 'f.bin') => {
  const result = new File([], name);
  Object.defineProperty(result, 'size', { value: size });

  return result;
};

describe('sendSealedMessage attachment limits', () => {
  it('refuses a file over 25 MiB before encrypting anything', async () => {
    const { store, newResource, getClientDb } = untouchedStore();

    await expect(
      sendSealedMessage(store, conversation, 'hi', undefined, [
        file(MAX_ATTACHMENT_BYTES + 1, 'big.mov'),
      ]),
    ).rejects.toThrow(/big\.mov is larger than 25 MiB/);
    expect(newResource).not.toHaveBeenCalled();
    expect(getClientDb).not.toHaveBeenCalled();
  });

  it('refuses an eleventh file before encrypting anything', async () => {
    const { store, newResource, getClientDb } = untouchedStore();

    await expect(
      sendSealedMessage(
        store,
        conversation,
        'hi',
        undefined,
        Array.from({ length: 11 }, () => file(1)),
      ),
    ).rejects.toThrow(/at most 10 attachments/);
    expect(newResource).not.toHaveBeenCalled();
    expect(getClientDb).not.toHaveBeenCalled();
  });
});
