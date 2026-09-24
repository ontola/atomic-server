// A plugin for testing. Not a real integration, and not something this repo
// ships: real plugins live in https://github.com/ontola/atomic-plugins and
// reach a server as JS bundles fetched over HTTP from a catalog.
//
// It exists so the host's own tests have a plugin to point at — the action,
// trigger and scheduler setups, discovery, and a schema sync. It is never the
// thing under test; it only has to hold up its end of the host's contract:
//
//   - `phase: 'action'` must return one external request, matching the
//     operation the manifest binds that action to. The host checks the
//     operation, method and URL against `manifest.json` before sending
//     anything, and refuses a request that exceeds them.
//   - every provider URL is built from the connection's `config.collection`,
//     never hardcoded, so a test that sees the expected URL has also proved
//     the host delivered the reviewed config to the plugin. The tests
//     configure `{"collection":"records"}`.
//   - `phase: 'discover'` runs before anything is configured. It returns what
//     setup may offer, and only that: provider fields it does not need are
//     dropped, not passed on.
//   - `phase: 'preview'` / `'step'` sync one schema field's name between the
//     provider and the Atomic property `config.field`. Either side may rename
//     it; the other follows, and the field stays bound to the same property.
//   - any other phase returns an ordinary verdict.
//
// The provider it names, `https://provider.test`, does not exist. Every test
// that reaches it mocks the response.

export const manifest = {
  schemaVersion: 1,
  operations: [],
  secrets: [],
};

const NAME = 'https://atomicdata.dev/properties/name';
const HEADERS = { Authorization: 'Bearer secret:provider' };
const FIELD = 'schema:field';

function endpoint(config) {
  const collection = config?.collection;

  if (typeof collection !== 'string' || !/^[a-z0-9-]+$/.test(collection)) {
    throw new Error('Plugin for testing needs config.collection');
  }

  return `https://provider.test/${collection}`;
}

function actionRequest(action, args, config) {
  const root = endpoint(config);

  switch (action) {
    case 'get_record':
      return {
        operation: 'get',
        method: 'GET',
        url: `${root}/${args.number}`,
      };
    case 'create_record':
      return {
        operation: 'create',
        method: 'POST',
        url: root,
        body: JSON.stringify({ title: args.title, body: args.body ?? '' }),
      };
    default:
      throw new Error(`Plugin for testing has no action ${action}`);
  }
}

function read(input, operation, url) {
  const response = input.http({
    operation,
    method: 'GET',
    url,
    headers: HEADERS,
  });

  if (response.status !== 200) {
    throw new Error(`Provider answered ${response.status} to ${operation}`);
  }

  return JSON.parse(response.body);
}

function discover(input) {
  const collections = read(
    input,
    'collections',
    'https://provider.test/collections',
  );

  return {
    intents: [],
    problems: [],
    discovery: {
      collections: collections.map(c => ({ id: c.id, name: c.name })),
    },
  };
}

function names(input) {
  const root = endpoint(input.config);

  return {
    local: input.read(input.config.field)[NAME],
    remote: read(input, 'schema', `${root}/schema`).name,
  };
}

function preview(input) {
  const { local, remote } = names(input);
  const baseline = input.connection.records[FIELD]?.baseline?.name;
  const problems = [];
  let change;

  if (local === remote) {
    change = undefined;
  } else if (baseline === undefined || local === baseline) {
    change = { side: 'local', name: remote };
  } else if (remote === baseline) {
    change = { side: 'remote', name: local };
  } else {
    problems.push({
      severity: 'error',
      message: `Field renamed on both sides: ${local} / ${remote}`,
    });
  }

  return {
    kind: 'preview',
    proposal: { field: input.config.field, local, remote, change },
    problems,
  };
}

function step(input) {
  const proposal = input.proposal;
  const cursor = input.cursor ?? { stage: 'start' };
  const change = proposal.change;

  if (proposal.field !== input.config.field) {
    throw new Error('Proposal was reviewed for another field');
  }

  if (cursor.stage === 'start' && change?.side === 'local') {
    return {
      kind: 'effect',
      effect: {
        kind: 'atomic',
        id: 'rename-local',
        verdict: {
          intents: [
            {
              op: 'set',
              subject: proposal.field,
              set: { [NAME]: change.name },
            },
          ],
          problems: [],
        },
      },
      cursor: { stage: 'verify' },
    };
  }

  if (cursor.stage === 'start' && change?.side === 'remote') {
    return {
      kind: 'effect',
      effect: {
        kind: 'external',
        id: 'rename-remote',
        request: {
          id: 'rename-remote',
          operation: 'rename',
          method: 'PATCH',
          url: `${endpoint(input.config)}/schema`,
          headers: HEADERS,
          body: JSON.stringify({ name: change.name }),
        },
      },
      cursor: { stage: 'verify' },
    };
  }

  if (cursor.stage === 'start' || cursor.stage === 'verify') {
    const { local, remote } = names(input);

    if (local !== remote) {
      throw new Error('Both sides must agree before checkpointing');
    }

    return {
      kind: 'effect',
      effect: {
        kind: 'checkpoint',
        id: 'checkpoint',
        records: [
          {
            remote: FIELD,
            local: proposal.field,
            local_projection: { name: local },
            remote_projection: { name: remote },
          },
        ],
      },
      cursor: { stage: 'done' },
    };
  }

  return { kind: 'complete' };
}

export function run(input) {
  switch (input.phase) {
    case 'action':
      return {
        id: 'action',
        headers: HEADERS,
        ...actionRequest(input.action, input.arguments ?? {}, input.config),
      };
    case 'discover':
      return discover(input);
    case 'preview':
      return preview(input);
    case 'step':
      return step(input);
    default:
      return {
        intents: [],
        problems: [
          {
            severity: 'warning',
            message: `Plugin for testing; ran at ${input.trigger?.at}.`,
          },
        ],
      };
  }
}
