import { describe, expect, it } from 'vitest';
import {
  auditCatalogs,
  auditProject,
  placeholdersMatch,
} from './check-translations.mjs';

function po(
  locale: string,
  entries: string,
  plural = 'nplurals=2; plural=(n != 1);',
) {
  return `msgid ""
msgstr ""
"Language: ${locale}\\n"
"Plural-Forms: ${plural}\\n"

${entries}\n`;
}

const source = po('en', 'msgid "Save"\nmsgstr "Save"');
const types = (target: string) =>
  auditCatalogs({ en: source, es: target }).issues.map(issue => issue.type);

describe('translation completeness', () => {
  it('reports missing entries, whitespace-only translations and fuzzy drafts', () => {
    expect(types(po('es', ''))).toContain('missing-entry');
    expect(types(po('es', 'msgid "Save"\nmsgstr "  "'))).toContain(
      'missing-translation',
    );
    expect(
      types(po('es', '#, fuzzy\nmsgid "Save"\nmsgstr "Guardar"')),
    ).toContain('fuzzy');
  });

  it('checks every plural form and preserves its count marker', () => {
    const en = po(
      'en',
      'msgid "# comment"\nmsgid_plural "# comments"\nmsgstr[0] "# comment"\nmsgstr[1] "# comments"',
    );
    const es = po(
      'es',
      'msgid "# comment"\nmsgid_plural "# comments"\nmsgstr[0] "# comentario"\nmsgstr[1] ""',
    );
    expect(auditCatalogs({ en, es }).issues.map(issue => issue.type)).toEqual([
      'missing-translation',
    ]);
    expect(
      auditCatalogs({
        en,
        es: es.replace('msgstr[1] ""', 'msgstr[1] "comentarios"'),
      }).issues.map(issue => issue.type),
    ).toEqual(['plural-count']);
  });

  it('reads continued strings and excludes obsolete records', () => {
    const es = po(
      'es',
      'msgid "Sa"\n"ve"\nmsgstr "Guar"\n"dar"\n\n#~ msgid "Old"\n#~ msgstr ""',
    );
    expect(auditCatalogs({ en: source, es }).issues).toEqual([]);
  });

  it('preserves counts when one target form covers every source plural form', () => {
    const en = po(
      'en',
      'msgid "1 Change"\nmsgid_plural "# Changes"\nmsgstr[0] "1 Change"\nmsgstr[1] "# Changes"',
    );
    const id = po(
      'id',
      'msgid "1 Change"\nmsgid_plural "# Changes"\nmsgstr[0] "# perubahan"',
      'nplurals=1; plural=0;',
    );
    expect(auditCatalogs({ en, id }).issues).toEqual([]);
    expect(
      auditCatalogs({
        en,
        id: id.replace('# perubahan', '1 perubahan'),
      }).issues.map(issue => issue.type),
    ).toEqual(['plural-count']);
    expect(
      auditCatalogs({ en, id: `${id}msgstr[1] "# perubahan"\n` }).issues.map(
        issue => issue.type,
      ),
    ).toEqual(['missing-translation']);
  });

  it('allows a single markerless plural form when the source has no count marker', () => {
    const en = po(
      'en',
      'msgid "edit"\nmsgid_plural "edits"\nmsgstr[0] "edit"\nmsgstr[1] "edits"',
    );
    const id = po(
      'id',
      'msgid "edit"\nmsgid_plural "edits"\nmsgstr[0] "suntingan"',
      'nplurals=1; plural=0;',
    );
    expect(auditCatalogs({ en, id }).issues).toEqual([]);
  });

  it('distinguishes contexts and reports duplicate active keys', () => {
    const entries = 'msgctxt "button"\nmsgid "Save"\nmsgstr "Guardar"';
    expect(types(po('es', entries))).toEqual(['extra', 'missing-entry']);
    expect(
      types(
        po(
          'es',
          'msgid "Save"\nmsgstr "Guardar"\n\nmsgid "Save"\nmsgstr "Salvar"',
        ),
      ),
    ).toContain('duplicate');
  });

  it('allows unchanged product names instead of treating all English matches as gaps', () => {
    const en = po('en', 'msgid "OpenRouter"\nmsgstr "OpenRouter"');
    const es = po('es', 'msgid "OpenRouter"\nmsgstr "OpenRouter"');
    expect(auditCatalogs({ en, es }).issues).toEqual([]);
    expect(auditCatalogs({ en, es }).summary[1].identical).toBe(1);
  });

  it('reports incorrect language and missing plural metadata', () => {
    const result = auditCatalogs({
      en: source,
      es: po('fr', 'msgid "Save"\nmsgstr "Guardar"', ''),
    });
    expect(result.issues.map(issue => issue.type)).toEqual([
      'header',
      'header',
    ]);
  });

  it('allows reordering while rejecting lost, duplicated and malformed placeholders', () => {
    expect(placeholdersMatch('{0} and {1}', '{1} y {0}')).toBe(true);
    expect(placeholdersMatch('{0} and {1}', '{0} y {0}')).toBe(false);
    expect(placeholdersMatch('<0>Help</0> <1/>', '<1/> <0>Ayuda</0>')).toBe(
      true,
    );
    expect(placeholdersMatch('<0>Help</0>', '<0>Ayuda')).toBe(false);
    expect(placeholdersMatch('<0><1>Help</1></0>', '<0><1>Ayuda</0></1>')).toBe(
      false,
    );
    expect(placeholdersMatch('<0>{1}</0>', '{1}<0>Ayuda</0>')).toBe(false);
  });

  it('keeps every supported UI catalog complete', async () => {
    const result = await auditProject();
    expect(result.issues).toEqual([]);
  });
});
