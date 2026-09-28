import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import { grantAgent, grantsTo, revokeAgent } from './agent-grants.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { agentSubject } from './subject.js';
import { testStore } from './test-store.js';

type TestStore = Awaited<ReturnType<typeof testStore>>['store'];

/** Answers `filters: {prop: value}` from memory, as `/search` would. */
function searchFromMemory(store: TestStore) {
  store.search = async (_query, opts = {}) => {
    const [[property, value]] = Object.entries(opts.filters ?? {});

    return [...store.resources.values()]
      .filter(resource =>
        ((resource.get(property) as string[] | undefined) ?? []).includes(
          value,
        ),
      )
      .map(resource => resource.subject);
  };
}

async function workspace(store: TestStore, owner: string, name: string) {
  const drive = await store.newResource({
    noParent: true,
    isA: server.classes.drive,
    propVals: {
      [core.properties.name]: name,
      [core.properties.read]: [owner],
      [core.properties.write]: [owner],
    },
  });
  await drive.save();

  return drive;
}

describe('agent grants', () => {
  it('finds, and then revokes, what an app key was given', async () => {
    const { store, agentDID } = await testStore();
    searchFromMemory(store);
    const app = agentSubject((await Agent.generateKeyPair()).publicKey);
    const notes = await workspace(store, agentDID, 'Notes');
    const other = await workspace(store, agentDID, 'Other');

    await grantAgent(store, app, [notes.subject], false);

    expect(await grantsTo(store, app)).toEqual([
      { subject: notes.subject, read: true, write: false },
    ]);
    expect(other.get(core.properties.read)).toEqual([agentDID]);

    // A resource the app created lists it in `write` only.
    await other.set(core.properties.write, [agentDID, app]);
    await other.save();
    expect(await grantsTo(store, app)).toContainEqual({
      subject: other.subject,
      read: false,
      write: true,
    });

    const report = await revokeAgent(store, app);

    expect(report.failed).toEqual([]);
    expect(report.revoked.sort()).toEqual(
      [notes.subject, other.subject].sort(),
    );
    expect(await grantsTo(store, app)).toEqual([]);
    expect(notes.get(core.properties.read)).toEqual([agentDID]);
  });
});
