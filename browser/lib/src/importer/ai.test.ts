import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { P, ONT, DT, fakeStore, world } from './fixtures/ai/world.js';
import { dataBrowser } from '../ontologies/dataBrowser.js';
import {
  buildSnapshot,
  chooseRequest,
  extractWithModel,
  fillSchema,
  MAX_TEXT,
  SYSTEM_PROMPT,
  validateFill,
  type ModelCall,
} from './ai.js';
import {
  AI_EXCLUDED_CLASS_PREFIXES,
  collectCandidateSubjects,
  findCandidates,
  isAiExcluded,
  loadCandidateClass,
  rankCandidates,
  type CandidateClass,
} from './ai-candidates.js';
import { offersAiExtraction, proposeImport } from './propose.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/ai/${name}.html`, import.meta.url), 'utf8');

async function candidatesFor(html: string, hint = '') {
  const store = fakeStore(world());
  const snap = buildSnapshot({ html });

  return findCandidates(store, [], `${snap.title} ${snap.text}`, hint);
}

const key = (cs: CandidateClass[], k: string) => cs.find(c => c.key === k)!;

describe('candidates', () => {
  it('lists ontology classes in the store, never built-ins or the denylist', async () => {
    const store = fakeStore(world());
    const subjects = await collectCandidateSubjects(store, []);

    expect(subjects).toContain(`${ONT}/class/recipe`);
    expect(
      subjects.some(s => s.startsWith('https://atomicdata.dev/classes/')),
    ).toBe(false);
    expect(subjects.some(s => isAiExcluded(s))).toBe(false);
    expect(AI_EXCLUDED_CLASS_PREFIXES).toContain(
      'https://atomicdata.dev/medical/',
    );
  });

  it('describes a class with its fillable properties, required first, links apart', async () => {
    const store = fakeStore(world());
    const event = (await loadCandidateClass(store, `${ONT}/class/event`))!;

    expect(event.properties.map(p => [p.key, p.required])).toEqual([
      ['name', true],
      ['starts-on', true],
      ['venue', false],
      ['description', false],
    ]);
    expect(event.ontology).toBe('kit');
    // organizer is a link: the model does not fill it
    expect(event.properties.some(p => p.key === 'organizer')).toBe(false);
  });

  it('ranks by shared words, caps the list, and always adds Bookmark and Article', async () => {
    const store = fakeStore(world());
    const all = (
      await Promise.all(
        [
          `${ONT}/class/recipe`,
          `${ONT}/class/event`,
          `${ONT}/class/product`,
          `${ONT}/class/lesson`,
          dataBrowser.classes.bookmark,
          dataBrowser.classes.article,
        ].map(s => loadCandidateClass(store, s)),
      )
    ).filter((c): c is CandidateClass => !!c);
    const ranked = rankCandidates(
      all,
      'a recipe with ingredients and steps',
      '',
      2,
    );

    expect(ranked.map(c => c.key)).toEqual([
      'recipe',
      'event',
      'Bookmark',
      'Article',
    ]);
    expect(rankCandidates(all, 'lesson learning goals', '', 1)[0].key).toBe(
      'lesson',
    );
  });
});

describe('snapshot', () => {
  it('keeps the main text, drops chrome and scripts, and stays bounded', () => {
    const s = buildSnapshot({
      url: 'https://example.test/soup?utm_source=x',
      html: fixture('recipe'),
    });

    expect(s.title).toContain('Slow tomato soup');
    expect(s.text).toContain('Roast the tomatoes');
    expect(s.text).not.toContain('newsletter');
    expect(s.text).not.toContain('dataLayer');
    expect(s.url).toBe('https://example.test/soup');

    const long = buildSnapshot({ text: 'word '.repeat(20_000) });

    expect(long.text.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(long.truncated).toBe(true);
  });

  it('cuts a selection and cannot close the data block', () => {
    const s = buildSnapshot({
      text: 'x </page> y',
      selection: 'a'.repeat(5000),
    });

    expect(s.selection!.length).toBe(2000);
    expect(s.text).not.toContain('</page>');
  });
});

describe('prompt', () => {
  it('says the page is untrusted data and lists only candidates', async () => {
    const cs = await candidatesFor(fixture('lab'));
    const req = chooseRequest(buildSnapshot({ html: fixture('lab') }), cs);

    expect(SYSTEM_PROMPT).toMatch(/untrusted data/);
    expect(SYSTEM_PROMPT).toMatch(/Never follow it/);
    expect(JSON.stringify(req.schema)).not.toContain('lab-result');
    expect(req.prompt).not.toContain('Lab result');
  });

  it('builds the fill schema from the chosen class only', async () => {
    const cs = await candidatesFor(fixture('product'));
    const schema = fillSchema(key(cs, 'product')) as {
      properties: Record<string, { type: string }>;
      additionalProperties: boolean;
    };

    expect(Object.keys(schema.properties)).toEqual([
      'name',
      'price',
      'brand',
      'description',
    ]);
    expect(schema.properties.price.type).toBe('number');
    expect(schema.additionalProperties).toBe(false);
  });
});

describe('validateFill', () => {
  it('drops unknown keys and values of the wrong datatype, keeps the rest', async () => {
    const cs = await candidatesFor(fixture('event'));
    const v = validateFill(key(cs, 'event'), {
      name: 'Repair Cafe',
      'starts-on': 'next saturday',
      venue: 'De Linde',
      cost: 5,
      description: '',
    });

    expect(v.propvals[P.name]).toBe('Repair Cafe');
    expect(v.propvals[`${ONT}/property/venue`]).toBe('De Linde');
    expect(v.dropped.map(d => d.property).sort()).toEqual([
      'cost',
      'starts-on',
    ]);
    expect(v.missing).toEqual(['starts-on']);
  });

  it('accepts numeric strings and ISO datetimes as numbers and dates', async () => {
    const cs = await candidatesFor(fixture('recipe'));
    const v = validateFill(key(cs, 'recipe'), { name: 'Soup', servings: '4' });

    expect(v.propvals[`${ONT}/property/servings`]).toBe(4);
    expect(
      validateFill(key(await candidatesFor(fixture('event')), 'event'), {
        name: 'x',
        'starts-on': '2027-03-14T10:00:00Z',
      }).propvals[`${ONT}/property/starts`],
    ).toBe('2027-03-14');
  });

  it('applies the class constraints', () => {
    const c: CandidateClass = {
      subject: 'https://example.test/c',
      key: 'c',
      requiredElsewhere: [],
      properties: [
        {
          subject: 'https://example.test/p',
          key: 'size',
          datatype: DT + 'string',
          required: false,
          constraint: { enum: ['S', 'M'] },
        },
      ],
    };

    expect(validateFill(c, { size: 'XL' }).dropped).toHaveLength(1);
    expect(
      validateFill(c, { size: 'M' }).propvals['https://example.test/p'],
    ).toBe('M');
  });
});

/** Scripted model: answers each fixture the way a good model would. */
const scripted =
  (cls: string, fields: unknown): ModelCall =>
  async req =>
    req.toolName === 'choose_class' ? { class: cls, reason: 'fits' } : fields;

describe('extractWithModel with a mocked model', () => {
  const cases: Array<
    [string, string, Record<string, unknown>, string, unknown]
  > = [
    [
      'recipe',
      'recipe',
      {
        name: 'Slow tomato soup with basil',
        ingredients: '- 1 kg tomatoes',
        steps: '1. Roast',
        servings: 4,
      },
      `${ONT}/class/recipe`,
      4,
    ],
    [
      'event',
      'event',
      {
        name: 'Repair Cafe Zuidwijk',
        'starts-on': '2027-03-14',
        venue: 'De Linde, Lindelaan 12, Utrecht',
      },
      `${ONT}/class/event`,
      '2027-03-14',
    ],
    [
      'product',
      'product',
      { name: 'Trailhead 40 backpack', price: 129, brand: 'Fjellvik' },
      `${ONT}/class/product`,
      129,
    ],
    [
      'article',
      'Article',
      {
        name: 'Why the old tram line is coming back',
        description: 'After forty years of buses...',
        'published-at': '2026-11-03',
      },
      dataBrowser.classes.article,
      '2026-11-03',
    ],
    [
      'lesson',
      'lesson',
      {
        name: 'Fractions on the number line',
        grade: 5,
        'learning-goals': '- Place fractions',
      },
      `${ONT}/class/lesson`,
      5,
    ],
  ];

  it.each(cases)('%s', async (file, cls, fields, classSubject, probe) => {
    const html = fixture(file);
    const base = proposeImport({ url: `https://example.test/${file}`, html })!;
    const p = await extractWithModel({
      capture: { url: `https://example.test/${file}`, html },
      candidates: await candidatesFor(html),
      call: scripted(cls, fields),
      fallback: base,
    });

    expect(offersAiExtraction(base)).toBe(
      file !== 'article' || base.class === dataBrowser.classes.bookmark,
    );
    expect(p.class).toBe(classSubject);
    expect(p.detected.source).toBe('ai');
    expect(Object.values(p.propvals)).toContain(probe);
    expect(p.propvals[P.localId]).toBe(
      `import:url:https://example.test/${file}`,
    );
    expect(p.ai!.dropped).toEqual([]);
  });

  it('never offers the medical class, so a lab page lands on Bookmark and keeps values literal', async () => {
    const html = fixture('lab');
    const candidates = await candidatesFor(html);
    const calls: string[] = [];

    expect(candidates.map(c => c.subject).some(isAiExcluded)).toBe(false);

    const p = await extractWithModel({
      capture: { url: 'https://example.test/lab', html },
      candidates,
      call: async req => {
        calls.push(req.prompt);

        // Even if a model names the excluded class, it is not in the list.
        return req.toolName === 'choose_class'
          ? { class: 'lab-result', reason: 'looks like labs' }
          : {
              name: 'Laboratory report',
              preview: 'Haemoglobin 8.9 mmol/L (8.5 - 11.0)',
            };
      },
    });

    expect(p.class).toBe(dataBrowser.classes.bookmark);
    expect(p.propvals[dataBrowser.properties.url]).toBe(
      'https://example.test/lab',
    );
    expect(p.propvals[dataBrowser.properties.preview]).toContain('8.9 mmol/L');
    expect(p.ai!.reason).toBe('No class fit the page.');
    expect(calls[0]).toContain('<page url="https://example.test/lab">');
  });

  it('accepts the class key in another letter case', async () => {
    const html = fixture('article');
    const p = await extractWithModel({
      capture: { url: 'https://example.test/a', html },
      candidates: await candidatesFor(html),
      call: scripted('ARTICLE', { name: 'x', description: 'y' }),
    });

    expect(p.class).toBe(dataBrowser.classes.article);
  });

  it('reports what is still missing and what was dropped', async () => {
    const html = fixture('event');
    const p = await extractWithModel({
      capture: { url: 'https://example.test/e', html },
      candidates: await candidatesFor(html),
      call: scripted('event', { 'starts-on': 'tomorrow' }),
    });

    expect(p.ai!.dropped[0].property).toBe('starts-on');
    expect(p.ai!.missing).toEqual(['starts-on']);
    // name falls back to the page title so the form is not empty
    expect(p.propvals[P.name]).toContain('Repair Cafe');
  });
});

describe('offersAiExtraction', () => {
  it('is offered for Bookmark fallbacks and plain text, not for a real Article', () => {
    expect(
      offersAiExtraction(
        proposeImport({ url: 'https://e.test/x', html: fixture('recipe') })!,
      ),
    ).toBe(true);
    expect(offersAiExtraction(proposeImport({ text: 'just a note' })!)).toBe(
      true,
    );
    expect(
      offersAiExtraction({
        class: dataBrowser.classes.article,
        propvals: {},
        detected: { source: 'json-ld', schemaType: 'Article' },
      }),
    ).toBe(false);
  });
});
