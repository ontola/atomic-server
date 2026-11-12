// @vitest-environment jsdom
// @wc-ignore-file
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addMarketplace,
  defaultPluginCatalogUrl,
  getMarketplaceUrls,
  removeMarketplace,
  resetMarketplaces,
} from './pluginCatalogUrl';

beforeEach(() => localStorage.clear());

const A = 'https://a.test/catalog.json';
const B = 'https://b.test/catalog.json';

describe('marketplaces', () => {
  it('is just the default when nothing is stored', () => {
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl]);
  });

  it('falls back to a legacy single-catalog value without writing it', () => {
    localStorage.setItem('plugin-catalog-url', A);
    expect(getMarketplaceUrls()).toEqual([A]);
    expect(localStorage.getItem('marketplaces')).toBeNull();
    localStorage.setItem('plugin-catalog-url', 'http://evil.test/x');
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl]);
  });

  it('keeps the extras of earlier versions after the primary catalog', () => {
    localStorage.setItem('plugin-marketplaces', JSON.stringify([A, B]));
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl, A, B]);
    localStorage.setItem('plugin-catalog-url', B);
    expect(getMarketplaceUrls()).toEqual([B, A]);
    addMarketplace('https://c.test/catalog.json');
    expect(getMarketplaceUrls()).toEqual([B, A, 'https://c.test/catalog.json']);
    resetMarketplaces();
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl]);
  });

  it('appends added URLs in order and removes them again', () => {
    addMarketplace(A);
    addMarketplace(` ${B} `);
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl, A, B]);
    removeMarketplace(A);
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl, B]);
  });

  it('ignores duplicates', () => {
    addMarketplace(A);
    addMarketplace(A);
    addMarketplace(defaultPluginCatalogUrl);
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl, A]);
  });

  it('lets the default be removed and stays empty, until reset', () => {
    removeMarketplace(defaultPluginCatalogUrl);
    expect(getMarketplaceUrls()).toEqual([]);
    removeMarketplace('https://nope.test/c.json');
    expect(getMarketplaceUrls()).toEqual([]);
    resetMarketplaces();
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl]);
  });

  it('rejects insecure and malformed URLs', () => {
    expect(() => addMarketplace('http://example.com/catalog.json')).toThrow();
    expect(() => addMarketplace('nope')).toThrow();
    expect(getMarketplaceUrls()).toEqual([defaultPluginCatalogUrl]);
  });

  it('drops stored values that no longer validate', () => {
    localStorage.setItem(
      'marketplaces',
      JSON.stringify(['http://example.com/x', 'https://ok.test/c.json', 5]),
    );
    expect(getMarketplaceUrls()).toEqual(['https://ok.test/c.json']);
    localStorage.setItem('marketplaces', '{broken');
    expect(getMarketplaceUrls()).toEqual([]);
  });
});
