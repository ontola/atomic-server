import { describe, expect, it } from 'vitest';
import { core } from '../ontologies/core.js';
import { dataBrowser } from '../ontologies/dataBrowser.js';
import { canonicalSourceUrl, importLocalId, proposeImport } from './propose.js';
import {
  barePage,
  eventPage,
  graphPage,
  openGraphPage,
  recipePage,
} from './fixtures.js';

const name = core.properties.name;
const description = core.properties.description;
const { url, preview, imageUrl, publishedAt } = dataBrowser.properties;

describe('proposeImport', () => {
  it('keeps a recipe as a Bookmark with the recipe as its markdown preview', () => {
    const p = proposeImport({
      url: 'https://example.test/pannenkoeken',
      html: recipePage,
    })!;

    expect(p.class).toBe(dataBrowser.classes.bookmark);
    expect(p.detected).toEqual({ source: 'json-ld', schemaType: 'Recipe' });
    expect(p.propvals[name]).toBe('Pannenkoeken');
    expect(p.propvals[url]).toBe('https://example.test/pannenkoeken');
    expect(p.propvals[imageUrl]).toBe('https://example.test/pannenkoek.jpg');
    expect(p.propvals[preview]).toContain('Prep time: 10 min');
    expect(p.propvals[preview]).toContain('- 250 g bloem');
    expect(p.propvals[preview]).toContain('2. Bak in de pan.');
  });

  it('describes an event with when and where', () => {
    const p = proposeImport({
      url: 'https://example.test/e',
      html: eventPage,
    })!;

    expect(p.detected.schemaType).toBe('Event');
    expect(p.propvals[name]).toBe('Open dag & borrel');
    expect(p.propvals[preview]).toContain('Starts: 2027-03-05T16:00:00+01:00');
    expect(p.propvals[preview]).toContain(
      'Where: Buurthuis, Dorpsstraat 1, Utrecht',
    );
  });

  it('uses OpenGraph when there is no JSON-LD, and the canonical URL', () => {
    const p = proposeImport({ html: openGraphPage })!;

    expect(p.class).toBe(dataBrowser.classes.bookmark);
    expect(p.detected.source).toBe('opengraph');
    expect(p.propvals[name]).toBe('Fietsen in de winter');
    expect(p.propvals[description]).toBe('Tips voor koude ritten.');
    expect(p.propvals[imageUrl]).toBe('https://example.test/fiets.jpg');
    expect(p.sourceUrl).toBe('https://example.test/fietsen');
    expect(p.propvals[core.properties.localId]).toBe(
      importLocalId('https://example.test/fietsen'),
    );
  });

  it('falls back to title and visible text for a page with nothing', () => {
    const p = proposeImport({ url: 'https://example.test/x', html: barePage })!;

    expect(p.class).toBe(dataBrowser.classes.bookmark);
    expect(p.detected.source).toBe('page');
    expect(p.propvals[name]).toBe('Test page');
    expect(p.propvals[description]).toContain('Alleen tekst');
    expect(p.propvals[description]).not.toContain('var x');
  });

  it('picks the main entity out of a JSON-LD @graph', () => {
    const p = proposeImport({
      url: 'https://example.test/post',
      html: graphPage,
    })!;

    expect(p.class).toBe(dataBrowser.classes.article);
    expect(p.detected.schemaType).toBe('BlogPosting');
    expect(p.propvals[name]).toBe('Zes weken later');
    expect(p.propvals[description]).toBe('Het begon in mei.');
    expect(p.propvals[publishedAt]).toBe('2026-06-01');
  });

  it('treats pasted markup as a page', () => {
    const p = proposeImport({ text: recipePage })!;

    expect(p.detected.schemaType).toBe('Recipe');
    expect(p.sourceUrl).toBeUndefined();
    expect(p.propvals[core.properties.localId]).toBeUndefined();
  });

  it('makes an Article of plain text without a URL', () => {
    const p = proposeImport({ text: '# Notitie\n\nIets om te onthouden.' })!;

    expect(p.class).toBe(dataBrowser.classes.article);
    expect(p.propvals[name]).toBe('Notitie');
    expect(p.propvals[description]).toContain('Iets om te onthouden.');
  });

  it('makes a Bookmark of a bare URL or of text with a URL', () => {
    const bare = proposeImport({ url: 'https://example.test/a' })!;

    expect(bare.class).toBe(dataBrowser.classes.bookmark);
    expect(bare.propvals[name]).toBe('https://example.test/a');

    const withText = proposeImport({
      url: 'https://example.test/a',
      text: 'Eerste regel\nRest',
    })!;

    expect(withText.propvals[name]).toBe('Eerste regel');
    expect(withText.propvals[preview]).toContain('Rest');
  });

  it('returns nothing for empty input and rejects non-http URLs', () => {
    expect(proposeImport({})).toBeUndefined();
    expect(proposeImport({ url: 'javascript:alert(1)' })).toBeUndefined();
  });

  it('survives a broken JSON-LD block', () => {
    const html = `<script type="application/ld+json">{nope</script>${openGraphPage}`;

    expect(proposeImport({ html })!.detected.source).toBe('opengraph');
  });
});

describe('canonicalSourceUrl', () => {
  it('drops fragment, tracking parameters and trailing slash', () => {
    expect(
      canonicalSourceUrl('https://Example.test/a/?utm_source=x&id=2#top'),
    ).toBe('https://example.test/a?id=2');
    expect(canonicalSourceUrl('ftp://example.test')).toBeUndefined();
  });
});
