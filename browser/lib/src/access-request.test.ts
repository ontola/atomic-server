import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';
import {
  APP_KEY_SCOPE_ALL_WORKSPACES,
  approveAccessRequest,
  authorizeRedirectUrl,
  authorizeReturnLabel,
  createAccessRequest,
  denyAccessRequest,
  expandAccessRequestTargets,
  isSafeRedirectUri,
  parseAuthorizeQuery,
  readAccessRequest,
} from './access-request.js';
import { bindAccessAgent } from './issue-access-agent.js';
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import { testStore } from './test-store.js';

async function createWorkspace(
  store: Awaited<ReturnType<typeof testStore>>['store'],
  owner: string,
  name: string,
) {
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

describe('parseAuthorizeQuery', () => {
  it('maps OAuth-style params onto a resource-level request', () => {
    const parsed = parseAuthorizeQuery(
      'name=Raycast&write=0&targets=*&state=abc',
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(parsed.spec).toEqual({
      name: 'Raycast',
      write: false,
      targets: [APP_KEY_SCOPE_ALL_WORKSPACES],
      state: 'abc',
    });
  });

  it('accepts write=true, a public key, and concrete targets', () => {
    const parsed = parseAuthorizeQuery(
      new URLSearchParams({
        name: 'Notes sync',
        write: 'true',
        targets: 'did:ad:folder1,did:ad:folder2',
        agent: 'did:ad:agent:pubkey',
        redirect_uri: 'https://example.com/cb',
      }),
    );

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(parsed.spec.write).toBe(true);
    expect(parsed.spec.targets).toEqual(['did:ad:folder1', 'did:ad:folder2']);
    expect(parsed.spec.publicKey).toBe('did:ad:agent:pubkey');
    expect(parsed.spec.redirectUri).toBe('https://example.com/cb');
  });

  it('rejects a request with no name', () => {
    const parsed = parseAuthorizeQuery('write=1');

    expect(parsed.ok).toBe(false);

    if (parsed.ok) {
      return;
    }

    expect(parsed.error).toMatch(/name/);
  });
});

describe('expandAccessRequestTargets', () => {
  it('expands the all-workspaces scope at consent time', () => {
    expect(
      expandAccessRequestTargets(
        [APP_KEY_SCOPE_ALL_WORKSPACES, 'did:ad:extra'],
        ['did:ad:a', 'did:ad:b'],
      ),
    ).toEqual(['did:ad:a', 'did:ad:b', 'did:ad:extra']);
  });
});

describe('authorizeRedirectUrl', () => {
  it('allows https and localhost, never javascript', () => {
    expect(isSafeRedirectUri('https://app.example/cb')).toBe(true);
    expect(isSafeRedirectUri('http://localhost:1234/cb')).toBe(true);
    expect(isSafeRedirectUri('raycast://oauth')).toBe(true);
    expect(isSafeRedirectUri('javascript:alert(1)')).toBe(false);
    expect(isSafeRedirectUri('http://evil.example')).toBe(false);
  });

  it('returns agent and state, never a secret', () => {
    const url = authorizeRedirectUrl('https://app.example/cb', {
      granted: true,
      agent: 'did:ad:agent:x',
      state: 's1',
    });

    expect(url).toContain('granted=true');
    expect(url).toContain('agent=did%3Aad%3Aagent%3Ax');
    expect(url).toContain('state=s1');
    expect(url).not.toMatch(/secret|private/i);
  });

  it('returns error=access_denied on deny, still without a secret', () => {
    const url = authorizeRedirectUrl('https://app.example/cb', {
      granted: false,
      state: 's1',
    });

    expect(url).toContain('granted=false');
    expect(url).toContain('error=access_denied');
    expect(url).toContain('state=s1');
    expect(url).not.toContain('agent=');
    expect(url).not.toMatch(/secret|private/i);
  });
});

describe('authorizeReturnLabel', () => {
  it('shows the host for http(s) and the scheme for native apps', () => {
    expect(authorizeReturnLabel('https://app.example/cb')).toBe('app.example');
    expect(authorizeReturnLabel('http://localhost:6747/cb')).toBe(
      'localhost:6747',
    );
    expect(authorizeReturnLabel('raycast://oauth')).toBe('raycast://oauth');
    expect(authorizeReturnLabel('javascript:alert(1)')).toBeUndefined();
  });
});

describe('createAccessRequest and approveAccessRequest', () => {
  it('stores a pending request, then mints a key on approve', async () => {
    const { store, agentDID } = await testStore();
    const drive = await createWorkspace(store, agentDID, 'Notes');
    const inbox = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'Requests' },
    });
    await inbox.save();
    const keysFolder = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'App keys' },
    });
    await keysFolder.save();

    const requestSubject = await createAccessRequest(store, {
      parent: inbox.subject,
      drive: drive.subject,
      name: 'Raycast',
      write: false,
      targets: [drive.subject],
      state: 'once',
    });

    const again = await createAccessRequest(store, {
      parent: inbox.subject,
      drive: drive.subject,
      name: 'Raycast',
      write: false,
      targets: [drive.subject],
      state: 'once',
    });
    expect(again).toBe(requestSubject);

    const spec = readAccessRequest(await store.getResource(requestSubject));
    expect(spec.name).toBe('Raycast');
    expect(spec.write).toBe(false);

    const approved = await approveAccessRequest(store, requestSubject, {
      targets: [drive.subject],
      parent: keysFolder.subject,
    });

    expect(approved.secret).toBeTruthy();
    expect(store.getAgent()?.subject).toBe(agentDID);
    expect(drive.get(core.properties.read) as string[]).toContain(
      approved.subject,
    );
    expect(drive.get(core.properties.write) as string[]).not.toContain(
      approved.subject,
    );

    const gone = await store.getResource(requestSubject);
    expect(gone.error || gone.new).toBeTruthy();
  });

  it('binds an app-minted public key and does not return a secret', async () => {
    const { store, agentDID } = await testStore();
    const drive = await createWorkspace(store, agentDID, 'Notes');
    const inbox = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'Requests' },
    });
    await inbox.save();
    const keysFolder = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'App keys' },
    });
    await keysFolder.save();

    const keys = await Agent.generateKeyPair();
    const requestSubject = await createAccessRequest(store, {
      parent: inbox.subject,
      drive: drive.subject,
      name: 'CLI',
      write: true,
      targets: [drive.subject],
      publicKey: keys.publicKey,
    });

    const approved = await approveAccessRequest(store, requestSubject, {
      targets: [drive.subject],
      parent: keysFolder.subject,
    });

    expect(approved.secret).toBeUndefined();
    expect(approved.subject).toBe(`did:ad:agent:${keys.publicKey}`);
    expect(drive.get(core.properties.write) as string[]).toContain(
      approved.subject,
    );
  });

  it('deny deletes the pending request without granting', async () => {
    const { store, agentDID } = await testStore();
    const drive = await createWorkspace(store, agentDID, 'Notes');
    const inbox = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'Requests' },
    });
    await inbox.save();

    const requestSubject = await createAccessRequest(store, {
      parent: inbox.subject,
      drive: drive.subject,
      name: 'Nope',
      write: true,
      targets: [drive.subject],
    });

    await denyAccessRequest(store, requestSubject);

    expect(drive.get(core.properties.write) as string[]).not.toContain(
      requestSubject,
    );
    const gone = await store.getResource(requestSubject);
    expect(gone.error || gone.new).toBeTruthy();
  });
});

describe('bindAccessAgent', () => {
  it('grants an existing public key without switching session', async () => {
    const { store, agentDID } = await testStore();
    const drive = await createWorkspace(store, agentDID, 'Notes');
    const keys = await Agent.generateKeyPair();

    const bound = await bindAccessAgent(store, {
      name: 'Plugin',
      publicKey: keys.publicKey,
      write: false,
      targets: [drive.subject],
    });

    expect(store.getAgent()?.subject).toBe(agentDID);
    expect(bound.subject).toBe(`did:ad:agent:${keys.publicKey}`);
    expect(drive.get(core.properties.read) as string[]).toContain(bound.subject);
  });
});
