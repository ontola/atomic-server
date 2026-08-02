import { describe, it } from 'vitest';
import { Store } from './store.js';

/**
 * Which inherited drive subjects are safe to restore.
 *
 * The cases below are taken verbatim from a real migrated account's `drives`
 * list (53 entries): 26 well-formed local drives, 11 pointing at dead dev
 * servers, 15 with the `staging` subdomain spliced into the path by the
 * migration, and a personal drive.
 *
 * The dead-dev-server ones are the dangerous class. Restoring them made an app
 * served from `https://staging.atomicdata.dev` issue XHRs against
 * `http://localhost:9883` — the signed-in user's own machine.
 */
describe('legacy drive subjects worth adopting', () => {
  const store = () =>
    new Store({ serverUrl: 'https://staging.atomicdata.dev' }) as unknown as {
      isAdoptableDriveSubject(s: string): boolean;
    };

  const adoptable = (s: string) => store().isAdoptableDriveSubject(s);

  it('keeps drives on this server', ({ expect }) => {
    expect(adoptable('https://staging.atomicdata.dev/drive/xzpv34r5ibr')).toBe(
      true,
    );
  });

  it('keeps DIDs, which are origin-independent', ({ expect }) => {
    expect(adoptable('did:ad:resource:abc123')).toBe(true);
  });

  it('drops drives on a dead dev server', ({ expect }) => {
    expect(adoptable('http://localhost:9883/01j71grbnyq2w922g2ttt7w46e')).toBe(
      false,
    );
    expect(
      adoptable('http://dawdawda.localhost:9883/01j3fqv30nqa0nevd3rnjnrsse'),
    ).toBe(false);
  });

  it('drops the migration-mangled subdomain spelling', ({ expect }) => {
    expect(adoptable('internal:/staging:/drive/ckggjb1d3md')).toBe(false);
    expect(
      adoptable('https://staging.atomicdata.dev/staging:/drive/KrOMdgvZ'),
    ).toBe(false);
  });

  it('drops any other origin, however well-formed', ({ expect }) => {
    expect(adoptable('https://example.com/drive/abc')).toBe(false);
  });

  it('drops unparseable junk rather than throwing', ({ expect }) => {
    expect(adoptable('not a url at all')).toBe(false);
    expect(adoptable('')).toBe(false);
  });
});
