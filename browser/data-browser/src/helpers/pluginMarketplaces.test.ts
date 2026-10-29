// @vitest-environment jsdom
// @wc-ignore-file
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMarketplace,
  defaultPluginCatalogUrl,
  getExtraMarketplaces,
  removeMarketplace,
} from './pluginCatalogUrl';

beforeEach(() => localStorage.clear());

describe('extra marketplaces', () => {
  it('stores added URLs in order and removes them again', () => {
    addMarketplace('https://a.test/catalog.json');
    addMarketplace(' https://b.test/catalog.json ');
    expect(getExtraMarketplaces()).toEqual([
      'https://a.test/catalog.json',
      'https://b.test/catalog.json',
    ]);
    removeMarketplace('https://a.test/catalog.json');
    expect(getExtraMarketplaces()).toEqual(['https://b.test/catalog.json']);
  });

  it('ignores duplicates and the primary catalog', () => {
    addMarketplace('https://a.test/catalog.json');
    addMarketplace('https://a.test/catalog.json');
    addMarketplace(defaultPluginCatalogUrl);
    expect(getExtraMarketplaces()).toEqual(['https://a.test/catalog.json']);
  });

  it('rejects insecure and malformed URLs', () => {
    expect(() => addMarketplace('http://example.com/catalog.json')).toThrow();
    expect(() => addMarketplace('nope')).toThrow();
    expect(getExtraMarketplaces()).toEqual([]);
  });

  it('drops stored values that no longer validate', () => {
    localStorage.setItem(
      'plugin-marketplaces',
      JSON.stringify(['http://example.com/x', 'https://ok.test/c.json', 5]),
    );
    expect(getExtraMarketplaces()).toEqual(['https://ok.test/c.json']);
    localStorage.setItem('plugin-marketplaces', '{broken');
    expect(getExtraMarketplaces()).toEqual([]);
  });
});
