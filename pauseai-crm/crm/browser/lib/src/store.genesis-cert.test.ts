import { describe, it, expect } from 'vitest';
import { testStore } from './test-store.js';
import { server } from './ontologies/server.js';
import { core } from './ontologies/core.js';
import { decodeB64 } from './base64.js';
import {
  decodeGenesisCert,
  verifyGenesisCert,
  genesisSignerDid,
} from './genesis.js';
import type { Resource } from './resource.js';

const GENESIS = 'https://atomicdata.dev/properties/genesis';
const DRIVE = 'https://atomicdata.dev/properties/drive';
const DID_PREFIX = 'did:ad:';

/** Every DID resource is born with a `did:ad:<cert-signature>` — never a
 * `_new:` placeholder — and carries the inline cert that verifies against it. */
async function assertCertMinted(resource: Resource, agentDID: string) {
  expect(resource.subject.startsWith(DID_PREFIX)).toBe(true);
  expect(resource.subject.startsWith('_new:')).toBe(false);

  const b64 = resource.get(GENESIS) as string | undefined;
  expect(typeof b64).toBe('string');

  const cert = decodeGenesisCert(decodeB64(b64!));
  const signature = resource.subject.slice(DID_PREFIX.length);
  // The cert must sign to THIS subject — i.e. the DID is this cert's signature.
  expect(await verifyGenesisCert(cert, signature)).toBe(true);
  // ...and its signer is the creating agent.
  expect(genesisSignerDid(cert)).toBe(agentDID);

  return cert;
}

describe('newResource mints a genesis-certificate DID at creation', () => {
  it('a drive is born with a cert-verified did:ad:, no placeholder or rename', async () => {
    const { store, agentDID } = await testStore();

    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: {
        [core.properties.name]: 'Test drive',
        [core.properties.write]: [agentDID],
        [core.properties.read]: [agentDID],
      },
    });

    const cert = await assertCertMinted(drive, agentDID);
    // A top-level drive has no parent/drive context in its cert.
    expect(cert.parent).toBe('');
    expect(cert.drive).toBe('');
  });

  it('a child binds its parent + drive into the signed cert', async () => {
    const { store, agentDID } = await testStore();

    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Test drive' },
    });

    const doc = await store.newResource({
      parent: drive.subject,
      propVals: { [core.properties.name]: 'A document' },
    });

    const cert = await assertCertMinted(doc, agentDID);
    // Immutable birth context, bound into the signature.
    expect(cert.parent).toBe(drive.subject);
    expect(cert.drive).toBe(drive.subject);
    // And stamped as the live propval the server's rights check consults.
    expect(doc.get(DRIVE)).toBe(drive.subject);
  });

  it('minting is stable — the subject does not change after creation', async () => {
    const { store } = await testStore();

    const drive = await store.newResource({
      isA: server.classes.drive,
      noParent: true,
      propVals: { [core.properties.name]: 'Test drive' },
    });
    const subjectAtBirth = drive.subject;

    // Re-signing must not re-derive a different subject (the old double-mint
    // bug): the cert rides in the doc, and the subject is already final.
    await drive.set(core.properties.description, 'edited');
    expect(drive.subject).toBe(subjectAtBirth);
  });
});
