import { describe, expect, it, vi } from 'vitest';
import {
  fetchTableChanges,
  parseTableChangesPage,
  TableChangesCursorExpiredError,
} from './table-changes.js';

const page = {
  changes: [
    {
      subject: 'https://example.com/row-1',
      kind: 'updated',
      version: { '123': 4 },
      at: 1_700_000_000_000,
    },
    {
      subject: 'https://example.com/row-2',
      kind: 'deleted',
      version: null,
      at: 1_700_000_000_001,
    },
  ],
  cursor: 'abc',
  hasMore: false,
};

function respond(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('table changes', () => {
  it('parses a page', () => {
    expect(parseTableChangesPage(page)).toEqual(page);
  });

  it('rejects malformed pages', () => {
    expect(() => parseTableChangesPage({ changes: [] })).toThrow();
    expect(() =>
      parseTableChangesPage({
        ...page,
        changes: [{ subject: 'x', kind: 'moved', at: 1 }],
      }),
    ).toThrow();
  });

  it('builds the request from table, since and limit', async () => {
    const fetchImpl = respond(200, page);
    const result = await fetchTableChanges(
      'https://example.com',
      undefined,
      'https://example.com/table',
      { since: 'c1', limit: 50 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(result.cursor).toBe('abc');
    const url = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(url.pathname).toBe('/changes');
    expect(url.searchParams.get('table')).toBe('https://example.com/table');
    expect(url.searchParams.get('since')).toBe('c1');
    expect(url.searchParams.get('limit')).toBe('50');
  });

  it('turns 410 into a typed resync error', async () => {
    const fetchImpl = respond(410, {
      error: 'CURSOR_EXPIRED',
      message: 'resync',
    });
    await expect(
      fetchTableChanges(
        'https://example.com',
        undefined,
        'https://example.com/table',
        { since: 'old' },
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toBeInstanceOf(TableChangesCursorExpiredError);
  });

  it('reports other failures', async () => {
    const fetchImpl = respond(400, { error: 'NOT_A_TABLE' });
    await expect(
      fetchTableChanges(
        'https://example.com',
        undefined,
        'https://example.com/folder',
        {},
        fetchImpl as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/NOT_A_TABLE/);
  });
});
