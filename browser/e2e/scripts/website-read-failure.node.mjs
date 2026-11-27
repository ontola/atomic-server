import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installWebsiteReadFailure } from '../tests/website-read-failure.ts';

test('the first read fails even when app boot outlasts the old failure window', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = 'atomic:website-document';
  const window = {};
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: window,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  installWebsiteReadFailure(target);
  t.mock.timers.tick(60_000);
  const calls = [];
  const store = {
    async getResource(subject, options) {
      assert.equal(this, store);
      calls.push({ subject, options });

      return subject;
    },
  };
  window.store = store;

  await assert.rejects(store.getResource(target), /timed out after 10000ms/);
  assert.equal(window.__atomicWebsiteReadFailure.failures, 1);
  assert.equal(await store.getResource('atomic:other'), 'atomic:other');
  window.__atomicWebsiteReadFailure.release();
  const options = { allowIncomplete: true };
  assert.equal(await store.getResource(target, options), target);
  assert.deepEqual(calls, [
    { subject: 'atomic:other', options: undefined },
    { subject: target, options },
  ]);
  assert.equal(window.__atomicWebsiteReadFailure.failures, 1);
});

test('a real read error still propagates after the injected failure is released', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const original = new Error('Real read failure');
  const window = {
    store: {
      async getResource() {
        throw original;
      },
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: window,
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else delete globalThis.window;
  });
  installWebsiteReadFailure('atomic:website-document');
  window.__atomicWebsiteReadFailure.release();
  await assert.rejects(
    window.store.getResource('atomic:website-document'),
    error => error === original,
  );
});
