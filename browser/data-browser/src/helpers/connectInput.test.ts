import { describe, expect, it } from 'vitest';
import { classifyConnectInput, describeUnreachable } from './connectInput';

const NODE = 'a'.repeat(64);

describe('classifyConnectInput', () => {
  it('ignores an empty box', () => {
    expect(classifyConnectInput('  ')).toEqual({ kind: 'empty' });
  });

  it('recognises pairing codes and node identifiers', () => {
    expect(classifyConnectInput(`atomic:node:${NODE}?v=1`).kind).toBe('code');
    expect(classifyConnectInput(`did:ad:node:${NODE}`).kind).toBe('code');
    expect(classifyConnectInput(`atomic://pair?node=${NODE}`).kind).toBe(
      'code',
    );
  });

  it('gives a bare host a scheme', () => {
    expect(classifyConnectInput('example.com')).toEqual({
      kind: 'server',
      url: 'https://example.com',
    });
    expect(classifyConnectInput('localhost:9883')).toEqual({
      kind: 'server',
      url: 'http://localhost:9883',
    });
  });

  it('keeps a full address as typed', () => {
    expect(classifyConnectInput('https://atomicserver.eu/')).toEqual({
      kind: 'server',
      url: 'https://atomicserver.eu',
    });
  });

  it('rejects text that is neither', () => {
    expect(classifyConnectInput('not an address').kind).toBe('invalid');
    expect(classifyConnectInput('did:ad:abc').kind).toBe('invalid');
  });
});

describe('local servers', () => {
  it.each([
    ['localhost:9883', 'http://localhost:9883'],
    ['http://localhost:9883', 'http://localhost:9883'],
    ['https://localhost:9883', 'https://localhost:9883'],
    ['127.0.0.1:9883', 'http://127.0.0.1:9883'],
    ['[::1]:9883', 'http://[::1]:9883'],
  ])('accepts %s', (typed, url) => {
    expect(classifyConnectInput(typed)).toEqual({ kind: 'server', url });
  });

  it('suggests http when a local server was tried over https', () => {
    expect(describeUnreachable('https://localhost:9883')).toContain(
      'http://localhost:9883',
    );
  });

  it('names the likely cause for a local server, and stays generic otherwise', () => {
    expect(describeUnreachable('http://127.0.0.1:9883')).toContain(
      'server is running',
    );
    expect(describeUnreachable('https://example.com')).toBe(
      'Could not reach that address.',
    );
  });
});
