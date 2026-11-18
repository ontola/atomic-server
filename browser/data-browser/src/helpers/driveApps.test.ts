import { describe, expect, it } from 'vitest';
import {
  appsForResource,
  buildOpenUrl,
  type ExternalAppInfo,
} from './driveApps';

const GREMIUM = 'https://openmeeting.nl/ns/classes/Gremium';
const app = (over: Partial<ExternalAppInfo> = {}): ExternalAppInfo => ({
  subject: 'did:ad:app',
  name: 'OpenMeeting',
  homepage: 'https://openmeeting.nl',
  openUrlTemplate: 'https://openmeeting.nl/open?subject={subject}',
  handlesClasses: [GREMIUM],
  ...over,
});

describe('buildOpenUrl', () => {
  it('fills in the URL-encoded subject', () => {
    expect(buildOpenUrl('https://a.nl/open?s={subject}', 'did:ad:x?a=b')).toBe(
      'https://a.nl/open?s=did%3Aad%3Ax%3Fa%3Db',
    );
  });

  it('rejects templates without a placeholder', () => {
    expect(buildOpenUrl('https://a.nl/open', 'did:ad:x')).toBeUndefined();
  });

  it('rejects non-http schemes and garbage', () => {
    expect(buildOpenUrl('javascript:alert({subject})', 'x')).toBeUndefined();
    expect(buildOpenUrl('{subject}', 'x')).toBeUndefined();
  });
});

describe('appsForResource', () => {
  it('matches an app that handles one of the resource classes', () => {
    const found = appsForResource([app()], ['other', GREMIUM], 'did:ad:r');

    expect(found).toHaveLength(1);
    expect(found[0].url).toBe(
      'https://openmeeting.nl/open?subject=did%3Aad%3Ar',
    );
  });

  it('ignores apps for other classes or without a template', () => {
    expect(appsForResource([app()], ['other'], 'did:ad:r')).toEqual([]);
    expect(
      appsForResource([app({ openUrlTemplate: undefined })], [GREMIUM], 'x'),
    ).toEqual([]);
  });

  it('returns one entry per matching app', () => {
    const found = appsForResource(
      [app(), app({ subject: 'did:ad:b', name: 'Other' })],
      [GREMIUM],
      'did:ad:r',
    );

    expect(found.map(f => f.app.name)).toEqual(['OpenMeeting', 'Other']);
  });
});
