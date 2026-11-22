// @wc-ignore-file
import { denyAmbientGlobals } from '@tomic/lib/plugin-sandbox.js';
import { createSandbox, type ToHost } from './codeModeSandbox';

const post = (m: ToHost) =>
  (globalThis as unknown as { postMessage: (m: ToHost) => void }).postMessage(
    m,
  );

// After `post` is captured: the script gets no network or storage of its own.
denyAmbientGlobals(
  globalThis as unknown as Record<string, unknown>,
  name => `${name} is not available in run_code; use the tools instead.`,
);

const handle = createSandbox(post);

globalThis.onmessage = e => void handle(e.data);
