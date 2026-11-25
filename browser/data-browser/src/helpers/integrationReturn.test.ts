// @wc-ignore-file
import { describe, expect, it, vi } from 'vitest';
import {
  deliverIntegrationReturn,
  integrationReturnAddress,
  parseIntegrationReturn,
  setIntegrationReturnListener,
} from './integrationReturn';

describe('integrationReturnAddress', () => {
  it('keeps the integrations page of the origin on the web', () => {
    expect(integrationReturnAddress(false, 'https://atomic.place')).toBe(
      'https://atomic.place/app/integrations',
    );
  });

  it('uses the deep link in the Tauri apps, whatever their webview origin', () => {
    for (const origin of ['tauri://localhost', 'http://tauri.localhost'])
      expect(integrationReturnAddress(true, origin)).toBe(
        'atomic://integrations/return',
      );
  });
});

describe('parseIntegrationReturn', () => {
  it('reads the query of a return link', () => {
    const p = parseIntegrationReturn(
      'atomic://integrations/return?integration_state=s&platform=github&connection_code=c',
    );

    expect(p?.get('integration_state')).toBe('s');
    expect(p?.get('connection_code')).toBe('c');
  });

  it('accepts a refusal, which has no code', () => {
    expect(
      parseIntegrationReturn(
        'atomic://integrations/return?integration_state=s&error=access_denied',
      ),
    ).toBeDefined();
  });

  it.each([
    'atomic://integrations/return',
    'atomic://integrations/return?platform=github',
    'atomic://integrations/other?integration_state=s',
    'atomic://pair?integration_state=s',
    'https://integrations/return?integration_state=s',
    'not a url',
  ])('ignores %s', uri => {
    expect(parseIntegrationReturn(uri)).toBeUndefined();
  });
});

describe('deliverIntegrationReturn', () => {
  it('keeps a return that arrives before the listener', () => {
    const p = new URLSearchParams('integration_state=early');
    deliverIntegrationReturn(p);
    const fn = vi.fn();
    const off = setIntegrationReturnListener(fn);

    expect(fn).toHaveBeenCalledWith(p);

    const q = new URLSearchParams('integration_state=live');
    deliverIntegrationReturn(q);
    expect(fn).toHaveBeenLastCalledWith(q);
    off();
  });
});
