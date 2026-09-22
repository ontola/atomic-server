// A plugin for testing. Not a real integration, and not something this repo
// ships: real plugins live in https://github.com/ontola/atomic-plugins and
// reach a server as JS bundles fetched over HTTP from a catalog.
//
// It exists so the host's own tests have a plugin to point at — the action,
// trigger and scheduler setups. It is never the thing under test; it only has
// to hold up its end of the host's contract:
//
//   - `phase: 'action'` must return one external request, matching the
//     operation the manifest binds that action to. The host checks the
//     operation, method and URL against `manifest.json` before sending
//     anything, and refuses a request that exceeds them.
//   - any other phase returns an ordinary verdict.
//
// The provider it names, `https://provider.test`, does not exist. Every test
// that reaches it mocks the response.

export const manifest = {
  schemaVersion: 1,
  operations: [],
  secrets: [],
};

function actionRequest(action, args) {
  switch (action) {
    case 'get_record':
      return {
        operation: 'get',
        method: 'GET',
        url: `https://provider.test/records/${args.number}`,
      };
    case 'create_record':
      return {
        operation: 'create',
        method: 'POST',
        url: 'https://provider.test/records',
        body: JSON.stringify({ title: args.title, body: args.body ?? '' }),
      };
    default:
      throw new Error(`Plugin for testing has no action ${action}`);
  }
}

export function run(input) {
  if (input.phase === 'action') {
    return {
      id: 'action',
      headers: { Authorization: 'Bearer secret:provider' },
      ...actionRequest(input.action, input.arguments ?? {}),
    };
  }

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
