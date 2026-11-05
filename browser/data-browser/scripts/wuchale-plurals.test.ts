import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, Hub, pofile, type Config } from 'wuchale';
import { adapter } from '@wuchale/jsx';
import { plural } from '../src/helpers/plural';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true })));
});

async function fixture(
  translation: string,
  rule = 'nplurals=1; plural=0;',
  source = ['1 Change', '# Changes'],
) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-wuchale-plurals-'));
  roots.push(root);
  await mkdir(join(root, 'src/locales'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const entry = `#: src/example.ts\nmsgid ${JSON.stringify(source[0])}\nmsgid_plural ${JSON.stringify(source[1])}\n`;
  const catalog = (locale: string, pluralRule: string, forms: string) =>
    `msgid ""\nmsgstr ""\n"Language: ${locale}\\n"\n"Plural-Forms: ${pluralRule}\\n"\n\n${entry}${forms}\n`;
  await writeFile(
    join(root, 'src/locales/en.po'),
    catalog(
      'en',
      'nplurals=2; plural=(n != 1);',
      `msgstr[0] ${JSON.stringify(source[0])}\nmsgstr[1] ${JSON.stringify(source[1])}`,
    ),
  );
  await writeFile(
    join(root, 'src/locales/id.po'),
    catalog('id', rule, translation),
  );
  const config: Config = {
    ...defaultConfig,
    locales: ['en', 'id'],
    ai: null,
    adapters: { main: adapter({ files: ['src/**/*.ts'], storage: pofile() }) },
  };
  const hub = await Hub.create('build', () => config, root);

  return { root, hub };
}

describe('Wuchale locale plural rules', () => {
  it('checks the target locale form count instead of the English count', async () => {
    const { hub } = await fixture('msgstr[0] "# perubahan"');
    expect((await hub.check()).errors).toEqual([]);
  });

  it('rejects English-shaped forms for a one-form locale', async () => {
    const { hub } = await fixture(
      'msgstr[0] "1 perubahan"\nmsgstr[1] "# perubahan"',
    );
    expect((await hub.check()).errors).toEqual([
      expect.objectContaining({ locale: 'id', type: 'unequalLength' }),
    ]);
  });

  it('checks all target forms for interpolation damage', async () => {
    const { hub } = await fixture(
      'msgstr[0] "# perubahan {0}"\nmsgstr[1] "# perubahan {0}"\nmsgstr[2] "# perubahan"',
      'nplurals=3; plural=n == 1 ? 0 : n == 2 ? 1 : 2;',
      ['1 Change {0}', '# Changes {0}'],
    );
    expect((await hub.check()).errors).toEqual([
      expect.objectContaining({ locale: 'id', type: 'notEquivalent' }),
    ]);
  });

  it('compares the single target form with the source plural placeholders', async () => {
    const { hub } = await fixture(
      'msgstr[0] "# perubahan {0}"',
      'nplurals=1; plural=0;',
      ['1 Change', '# Changes {0}'],
    );
    expect((await hub.check()).errors).toEqual([]);
  });

  it('compiles one-form plural messages as arrays with the locale rule', async () => {
    const { root } = await fixture('msgstr[0] "# perubahan"');
    const compiled = await readFile(
      join(root, 'src/locales/.wuchale/main.0.id.compiled.js'),
      'utf8',
    );
    const catalog = await import(
      /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
    );
    expect(catalog.c).toEqual([['# perubahan']]);
    expect(typeof catalog.p).toBe('function');
    expect(
      [0, 1, 2].map(count => plural(count, catalog.c[0], catalog.p)),
    ).toEqual(['0 perubahan', '1 perubahan', '2 perubahan']);
  });
});
