import { describe, it } from 'vitest';
import { Store } from './store.js';
import { CollectionBuilder } from './collectionBuilder.js';

describe('CollectionBuilder', () => {
  it('does not default `drive` to the server origin string', ({ expect }) => {
    // Bug regression: `collectionBuilder.ts:18` used to fall back to
    // `this.server` (the server origin, e.g. `http://localhost:9883`)
    // when `setDrive` wasn't called. The server then filters
    // `drive == "http://localhost:9883"` which never matches any
    // real resource (real resources are scoped by their drive's DID),
    // so every such query is wasted work.
    const driveDid =
      'did:ad:N83svlEm4CTH4U8zWBzSVY77rf3putpVNQPbppZAFafk/NAMP0jKgeNj8i6kKLzy/v2UVk2bHXoelNchKSKbCQ==';
    const store = new Store({ serverUrl: 'http://localhost:9883' });
    store.setDrive(driveDid);

    const collection = new CollectionBuilder(store)
      .setProperty('https://atomicdata.dev/properties/parent')
      .setValue(driveDid)
      .build();

    // Read the params field via bracket access — test-only encapsulation break.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drive = (collection as any).params.drive as string | undefined;

    expect(drive, 'CollectionBuilder default drive').not.toBe(
      'http://localhost:9883',
    );
    expect(
      drive,
      'CollectionBuilder default drive should be a did:ad:... DID, undefined, ' +
        'or the active drive — never the server origin',
    ).toMatch(/^(did:ad:|$)|undefined/);
  });

  it('defaults `drive` to the active drive when none is explicitly set', ({
    expect,
  }) => {
    const driveDid =
      'did:ad:N83svlEm4CTH4U8zWBzSVY77rf3putpVNQPbppZAFafk/NAMP0jKgeNj8i6kKLzy/v2UVk2bHXoelNchKSKbCQ==';
    const store = new Store({ serverUrl: 'http://localhost:9883' });
    store.setDrive(driveDid);

    const collection = new CollectionBuilder(store)
      .setProperty('https://atomicdata.dev/properties/parent')
      .setValue(driveDid)
      .build();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drive = (collection as any).params.drive as string | undefined;
    expect(drive).toBe(driveDid);
  });

  it('preserves an explicit `setDrive` value', ({ expect }) => {
    const driveA =
      'did:ad:N83svlEm4CTH4U8zWBzSVY77rf3putpVNQPbppZAFafk/NAMP0jKgeNj8i6kKLzy/v2UVk2bHXoelNchKSKbCQ==';
    const driveB =
      'did:ad:6AzxES0pBgS68Dktw9YRQ4VtcFooBaazzzzzzzzzzzzz/zzzzzzzzzzzzzzzzzzzzz/zzzzzzzzzzzzzzzzzzzz==';
    const store = new Store({ serverUrl: 'http://localhost:9883' });
    store.setDrive(driveA);

    const collection = new CollectionBuilder(store)
      .setDrive(driveB)
      .setProperty('https://atomicdata.dev/properties/parent')
      .setValue(driveB)
      .build();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const drive = (collection as any).params.drive as string | undefined;
    expect(drive).toBe(driveB);
  });
});
