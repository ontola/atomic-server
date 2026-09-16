import { P } from './model.js';
export const id = '11111111-1111-1111-1111-111111111111',
  pid = '22222222-2222-2222-2222-222222222222';
export function fixture() {
  const config = {
    dataSource: id,
    table: 'did:ad:table',
    rowClass: 'did:ad:class',
    identity: 'did:ad:id',
    arrival: 'did:ad:arrival',
    fields: [
      { id: 'title', property: 'did:ad:title', type: 'title' },
      { id: 'n', property: 'did:ad:n', type: 'number' },
    ],
    views: [],
  };
  const records: any = {
    'did:ad:title': { [P.name]: 'Name' },
    'did:ad:n': { [P.name]: 'Count' },
  };
  const schema = {
    id,
    properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
      Count: { id: 'n', name: 'Count', type: 'number' },
    },
  };
  const page = {
    object: 'page',
    id: pid,
    parent: { data_source_id: id },
    properties: {
      Name: {
        id: 'title',
        type: 'title',
        title: [{ type: 'text', text: { content: 'Task' } }],
      },
      Count: { id: 'n', type: 'number', number: 2 },
    },
  };
  const responses: any = {
    schema,
    query: { results: [page], has_more: false, next_cursor: null },
    page,
  };
  const input: any = {
    phase: 'preview',
    config,
    connection: { revision: 0, records: {}, cursor: null },
    read: (s: string) => {
      if (!records[s]) throw Error('Not found');
      return records[s];
    },
    query: (p: string, v: string) =>
      Object.keys(records).filter(s => records[s][p] === v),
    http: (r: any) => ({
      status: 200,
      body: JSON.stringify(responses[r.operation]),
    }),
  };
  return { input, records, responses, page };
}
