import { it, expect } from 'vitest';
import { run } from './plugin.js';
import { P } from './model.js';
// Authored API fixtures, not live Notion conformance evidence.
import { id, pid, fixture } from './fixture.js';
it('discovers rows and stable property identities without writes', () => {
  const f = fixture();
  const out: any = run(f.input);
  expect(out.kind).toBe('preview');
  expect(out.problems).toEqual([]);
  expect(out.proposal.changes.map((x: any) => x.kind)).toEqual([
    'schema',
    'schema',
    'page',
  ]);
});
it('fails closed for looping pagination, schema changes and duplicate bindings', () => {
  const f = fixture();
  f.responses.query = { results: [], has_more: true, next_cursor: 'same' };
  expect(() => run(f.input)).toThrow('pagination');
  f.responses.schema.properties.Count.type = 'formula';
  expect(() => run(f.input)).toThrow('changed type');
});
it('uses acknowledged baselines for independent field edits and conflicts', () => {
  const f = fixture();
  f.records.row = {
    [P.parent]: f.input.config.table,
    [P.isA]: [f.input.config.rowClass],
    [P.name]: 'Local title',
    'did:ad:title': 'Local title',
    'did:ad:n': 1,
    'did:ad:id': pid,
  };
  f.input.connection = {
    revision: 1,
    records: {
      [`page:${pid}`]: { local: 'row', baseline: { title: 'Task', n: 1 } },
    },
  };
  let out: any = run(f.input);
  expect(out.proposal.changes.at(-1).desired).toEqual({
    title: 'Local title',
    n: 2,
  });
  f.records.row['did:ad:n'] = 3;
  out = run(f.input);
  expect(out.problems[0].message).toContain('n');
});
it('rejects edits made after preview before proposing any writes', () => {
  const f = fixture();
  const out: any = run(f.input);
  f.input.phase = 'step';
  f.input.proposal = out.proposal;
  f.records['did:ad:title'][P.name] = 'Changed';
  expect(() => run(f.input)).toThrow('after preview');
});
it('stops on access and rate-limit errors instead of treating them as empty data', () => {
  for (const status of [403, 404, 429]) {
    const f = fixture();
    f.input.http = () => ({ status, body: '{}' });
    expect(() => run(f.input)).toThrow(`Notion returned ${status}`);
  }
});
