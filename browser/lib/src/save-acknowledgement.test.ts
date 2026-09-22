import { afterEach, describe, expect, it, vi } from 'vitest';
import { core } from './ontologies/core.js';
import { testStore } from './test-store.js';
import { AtomicError, ErrorType, RequestCancelledError } from './error.js';
import { BLOCK_AFTER_FAILURES } from './local-outbox.js';
import { ErrorCode } from './ws-v2.js';

afterEach(() => vi.restoreAllMocks());

describe('explicit save acknowledgement', () => {
  it.each([
    'Unauthorized: no write rights in parent',
    'Property content missing. Is required in class Message',
    'is_genesis: true, but the resource already exists',
  ])('rejects a server refusal: %s', async message => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
      propVals: { [core.properties.name]: 'Rejected' },
    });
    const error = new Error(message);
    postCommitSpy.mockRejectedValue(error);

    await expect(doc.save()).rejects.toBe(error);
    expect(doc.commitError).toBe(error);
    store.setServerConnected(false);
  });

  it('does not report a backed-off retry as persisted', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    const error = new Error('server temporarily unavailable');
    postCommitSpy.mockRejectedValue(error);
    await doc.save().catch(() => undefined);
    const attempts = postCommitSpy.mock.calls.length;

    await expect(doc.save()).rejects.toBe(error);
    expect(postCommitSpy).toHaveBeenCalledTimes(attempts);
    store.setServerConnected(false);
  });

  it('keeps transport failures queued and returns offline', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    postCommitSpy.mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(doc.save()).resolves.toBe('offline');
    expect(store.outbox.hasPending(doc.subject)).toBe(true);
    expect(store.serverConnected).toBe(false);
  });
  it('clears the error after a successful retry', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    const error = new Error('temporary refusal');
    postCommitSpy.mockRejectedValueOnce(error);
    await expect(doc.save()).rejects.toBe(error);
    store.outbox.getEntry(doc.subject)!.lastAttemptAt = 0;

    await expect(doc.save()).resolves.toBe('persisted');
    expect(doc.commitError).toBeUndefined();
    expect(store.outbox.hasPending(doc.subject)).toBe(false);
    store.setServerConnected(false);
  });

  it('rejects a blocked entry without posting again', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    const error = new Error('Unauthorized: no write rights in parent');
    postCommitSpy.mockRejectedValue(error);
    await expect(doc.save()).rejects.toBe(error);
    const entry = store.outbox.getEntry(doc.subject)!;
    entry.failures = BLOCK_AFTER_FAILURES;
    entry.blocked = true;
    const attempts = postCommitSpy.mock.calls.length;

    await expect(doc.save()).rejects.toBe(error);
    expect(postCommitSpy).toHaveBeenCalledTimes(attempts);
    store.setServerConnected(false);
  });

  it('does not let an unrelated failure reject an acknowledged save', async () => {
    const { store, postCommitSpy } = await testStore();
    const rejected = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    const accepted = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    postCommitSpy.mockRejectedValueOnce(new Error('temporary refusal'));
    await rejected.save().catch(() => undefined);

    await expect(accepted.save()).resolves.toBe('persisted');
    expect(store.outbox.hasPending(rejected.subject)).toBe(true);
    store.setServerConnected(false);
  });

  it('rejects cancellation without losing the queued write', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    const error = new RequestCancelledError();
    postCommitSpy.mockRejectedValue(error);

    await expect(doc.save()).rejects.toBe(error);
    expect(store.outbox.hasPending(doc.subject)).toBe(true);
    store.setServerConnected(false);
  });

  it('allows an acknowledged save while a newer edit remains dirty', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    await doc.save();
    await doc.set(core.properties.name, 'Saved edit', false);
    postCommitSpy.mockImplementationOnce(async commit => {
      await doc.set(core.properties.name, 'Newer edit', false);

      return {
        ...commit,
        id: `https://example.com/commits/${commit.signature}`,
      };
    });

    await expect(doc.save()).resolves.toBe('persisted');
    expect(doc.get(core.properties.name)).toBe('Newer edit');
    expect(doc.hasOpsPastSaveCursor()).toBe(true);
    store.setServerConnected(false);
  });

  it('rejects a failed update to an existing resource', async () => {
    const { store, postCommitSpy } = await testStore();
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    await doc.save();
    await doc.set(core.properties.name, 'Rejected update', false);
    const error = new Error('Unauthorized: no write rights');
    postCommitSpy.mockRejectedValue(error);

    await expect(doc.save()).rejects.toBe(error);
    expect(doc.hasOpsPastSaveCursor()).toBe(true);
    expect(store.outbox.hasPending(doc.subject)).toBe(true);
    store.setServerConnected(false);
  });
});

describe('terminal drops are classified by error code, not message text', () => {
  // The server's structured `code` (WS `ERROR` frame or the `errorCode`
  // property on the HTTP `/commit` error body) decides whether a refusal is
  // terminal and whether the drop is benign. Message matching only covers
  // code-less responses from older servers, so a wording change on the server
  // cannot turn a terminal refusal into infinite retries.
  const LEGACY_GENESIS =
    'Commit for did:ad:abc has is_genesis: true, but the resource already exists.';

  async function saveRejectedWith(error: Error) {
    const { store, postCommitSpy } = await testStore();
    const notify = vi
      .spyOn(store, 'notifyError')
      .mockImplementation(() => undefined);
    const doc = await store.newResource({
      isA: 'https://atomicdata.dev/classes/Drive',
      noParent: true,
    });
    postCommitSpy.mockRejectedValue(error);
    await expect(doc.save()).rejects.toBe(error);
    const pending = store.outbox.hasPending(doc.subject);
    store.setServerConnected(false);

    return { pending, notified: notify.mock.calls.length };
  }

  it.each([ErrorCode.GENESIS_COLLISION, ErrorCode.IMMUTABLE_COMMIT])(
    'code %s with an unrelated message drops the entry silently',
    async code => {
      const { pending, notified } = await saveRejectedWith(
        new AtomicError(
          'refused, in words this client has never seen',
          ErrorType.Server,
          code,
        ),
      );
      expect(pending).toBe(false);
      expect(notified).toBe(0);
    },
  );

  it('a code-less legacy genesis-collision message still drops silently', async () => {
    const { pending, notified } = await saveRejectedWith(
      new Error(LEGACY_GENESIS),
    );
    expect(pending).toBe(false);
    expect(notified).toBe(0);
  });

  it("the HTTP error body's errorCode is honoured over its description", async () => {
    // `Client.postCommit` wraps a non-200 body in `AtomicError(body)`, whose
    // constructor reads `errorCode` off the JSON-AD error resource.
    const body = JSON.stringify({
      'https://atomicdata.dev/properties/description': 'unrelated wording',
      'https://atomicdata.dev/properties/errorCode':
        ErrorCode.GENESIS_COLLISION,
    });
    const { pending, notified } = await saveRejectedWith(
      new AtomicError(body, ErrorType.Server),
    );
    expect(pending).toBe(false);
    expect(notified).toBe(0);
  });

  it('another code keeps the entry even when the message has the legacy phrase', async () => {
    const { pending } = await saveRejectedWith(
      new AtomicError(
        LEGACY_GENESIS,
        ErrorType.Server,
        ErrorCode.UNAUTHORIZED_WRITE,
      ),
    );
    expect(pending).toBe(true);
  });

  it('a lost-write terminal code drops the entry and tells the user', async () => {
    const { pending, notified } = await saveRejectedWith(
      new AtomicError(
        'unrelated wording',
        ErrorType.Server,
        ErrorCode.MISSING_REQUIRED_PROPERTY,
      ),
    );
    expect(pending).toBe(false);
    expect(notified).toBe(1);
  });
});
