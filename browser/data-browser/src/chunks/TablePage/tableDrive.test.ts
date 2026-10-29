// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { getTableDrive } from './tableDrive';

const DRIVE_PROP = 'https://atomicdata.dev/properties/drive';
const TABLE = 'did:ad:table';

const resource = (props: Record<string, unknown>) =>
  ({ subject: TABLE, get: (p: string) => props[p] }) as never;

const store = (driveOf: (s: string) => string) =>
  ({ driveOfSubject: driveOf }) as never;

describe('getTableDrive', () => {
  it('prefers the drive propval of the table', () => {
    expect(
      getTableDrive(
        store(() => 'did:ad:other'),
        resource({ [DRIVE_PROP]: 'did:ad:driveB' }),
      ),
    ).toBe('did:ad:driveB');
  });

  it('walks the loaded parent chain when there is no drive propval', () => {
    expect(
      getTableDrive(
        store(() => 'did:ad:driveB'),
        resource({}),
      ),
    ).toBe('did:ad:driveB');
  });

  it('is undefined when nothing is known', () => {
    // Parent chain not loaded: the walk hands back the table itself.
    expect(
      getTableDrive(
        store(s => s),
        resource({}),
      ),
    ).toBeUndefined();
  });
});
