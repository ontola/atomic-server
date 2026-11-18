import { describe, expect, it, vi, afterEach } from 'vitest';
import { PeerReceiptRequests } from './peer-receipts.js';
import { LoroLoader } from './loro-loader.js';
import { encodeB64 } from './base64.js';
import type { AttachmentManifest } from './resource-attachment-evidence.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  let manifest: AttachmentManifest = {
    files: [{ subject: 'atomic:file', hash: 'a'.repeat(64), chunks: [] }],
  };
  const source = { storageId: 'b'.repeat(64), generation: 'c'.repeat(64) };
  const replica = { storageId: 'd'.repeat(64), generation: 'e'.repeat(64) };
  const send = vi.fn(async (_frame: Uint8Array) => {});
  const onReceipt = vi.fn();
  const requests = new PeerReceiptRequests({
    drive: 'atomic:drive',
    connectionId: 'peer',
    current: () => true,
    getSource: async () => source,
    canSend: async () => true,
    send,
    onReceipt,
    attachmentManifest: () => manifest,
  });
  const observe = () =>
    requests.observe(
      'atomic:file',
      encodeB64(
        new LoroLoader.Loro.VersionVector(new Map([['1', 1]])).encode(),
      ),
    );

  const respond = (index: number, extra = {}) => {
    const request = JSON.parse(
      new TextDecoder().decode(send.mock.calls[index][0].subarray(1)),
    );

    return requests.receive(
      new Uint8Array([
        0x59,
        ...new TextEncoder().encode(
          JSON.stringify({
            ...request,
            replica,
            barrier: 'atomic-attachment-flush-v1',
            ...extra,
          }),
        ),
      ]),
    );
  };

  return {
    requests,
    send,
    onReceipt,
    observe,
    respond,
    replace: () => {
      manifest = {
        files: [{ subject: 'atomic:file', hash: 'f'.repeat(64), chunks: [] }],
      };
    },
  };
}

describe('attachment peer receipt negotiation and exact content', () => {
  it('cancels a root receipt when an attached child is removed, then allows a fresh probe', async () => {
    const source = { storageId: 'b'.repeat(64), generation: 'c'.repeat(64) };
    const send = vi.fn(async (_frame: Uint8Array) => {});
    const onReceipt = vi.fn();
    const requests = new PeerReceiptRequests({
      drive: 'atomic:drive',
      connectionId: 'peer',
      current: () => true,
      getSource: async () => source,
      canSend: async () => true,
      send,
      onReceipt,
      attachmentManifest: () => ({
        files: [{ subject: 'atomic:child', hash: 'a'.repeat(64), chunks: [] }],
      }),
    });
    const observe = () =>
      requests.observe(
        'atomic:root',
        encodeB64(
          new LoroLoader.Loro.VersionVector(new Map([['1', 1]])).encode(),
        ),
      );
    requests.enable('atomic:agent:peer');
    observe();
    await requests.tick();
    const reply = (index: number) =>
      new Uint8Array([
        0x59,
        ...new TextEncoder().encode(
          JSON.stringify({
            ...JSON.parse(
              new TextDecoder().decode(send.mock.calls[index][0].subarray(1)),
            ),
            replica: { storageId: 'd'.repeat(64), generation: 'e'.repeat(64) },
            barrier: 'atomic-attachment-flush-v1',
          }),
        ),
      ]);
    requests.remove('atomic:child');
    await requests.receive(reply(0));
    expect(onReceipt).not.toHaveBeenCalled();
    observe();
    await requests.tick();
    await requests.receive(reply(1));
    expect(onReceipt).toHaveBeenCalledOnce();
  });

  it('requires capability/auth and correlates the captured manifest, not later file contents', async () => {
    const f = fixture();
    f.observe();
    await f.requests.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.requests.enable('atomic:agent:peer');
    await f.requests.tick();
    expect(f.send.mock.calls[0][0][0]).toBe(0x58);
    f.replace();
    await f.respond(0, {
      manifest: {
        files: [{ subject: 'atomic:file', hash: 'f'.repeat(64), chunks: [] }],
      },
    });
    expect(f.onReceipt).not.toHaveBeenCalled();
    await f.respond(0);
    expect(f.onReceipt.mock.calls[0][0].manifest.files[0].hash).toBe(
      'a'.repeat(64),
    );
    f.observe();
    await f.requests.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('cannot accept the metadata barrier or a reply after removal', async () => {
    const f = fixture();
    f.requests.enable('atomic:agent:peer');
    f.observe();
    await f.requests.tick();
    await f.respond(0, { barrier: 'atomic-redb-flush-v1' });
    expect(f.onReceipt).not.toHaveBeenCalled();
    f.requests.remove('atomic:file');
    await f.respond(0);
    expect(f.onReceipt).not.toHaveBeenCalled();
    f.observe();
    await f.requests.tick();
    await f.respond(1);
    expect(f.onReceipt).toHaveBeenCalledOnce();
  });
  it('reprobes confirmed bytes periodically so remote deletion cannot retain proof forever', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.requests.enable('atomic:agent:peer');
    f.observe();
    await f.requests.tick();
    await f.respond(0);
    f.observe();
    await f.requests.tick();
    expect(f.send).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(10_001);
    f.observe();
    await f.requests.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    const first = JSON.parse(
      new TextDecoder().decode(f.send.mock.calls[0][0].subarray(1)),
    );
    const second = JSON.parse(
      new TextDecoder().decode(f.send.mock.calls[1][0].subarray(1)),
    );
    expect(second.nonce).not.toBe(first.nonce);
    await f.respond(0);
    expect(f.onReceipt).toHaveBeenCalledOnce();
    await f.respond(1);
    expect(f.onReceipt).toHaveBeenCalledTimes(2);
  });
});
