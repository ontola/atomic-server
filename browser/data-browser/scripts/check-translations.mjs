#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import PO from 'pofile';
import { compileTranslation, isEquivalent } from 'wuchale/compiler';

const key = item =>
  JSON.stringify([item.msgctxt, item.msgid, item.msgid_plural]);

// Reordering is valid; deleting, duplicating or unbalancing placeholders is not.
function tokens(text) {
  const found = text.match(/\{\d+\}|<\/?\d+\/?>/g) ?? [];
  const stack = [];

  for (const token of found) {
    if (/^<\d+>$/.test(token)) stack.push(token.slice(1, -1));
    if (/^<\/\d+>$/.test(token) && stack.pop() !== token.slice(2, -1))
      return null;
  }

  return stack.length ? null : found.sort().join('|');
}

export function placeholdersMatch(source, target) {
  const sourceTokens = tokens(source);
  if (sourceTokens === null || sourceTokens !== tokens(target)) return false;

  return isEquivalent(
    compileTranslation(source, source),
    compileTranslation(target, target),
  );
}

/** Read-only, plural-aware audit. Identical words are informational, not errors. */
export function auditCatalogs(catalogs, sourceLocale = 'en') {
  const parsed = new Map(
    Object.entries(catalogs).map(([locale, text]) => [locale, PO.parse(text)]),
  );
  const source = parsed.get(sourceLocale);
  if (!source) throw new Error(`Missing source catalog: ${sourceLocale}`);
  const sources = new Map(
    source.items.filter(item => !item.obsolete).map(item => [key(item), item]),
  );
  const issues = [];
  const summary = [];

  for (const [locale, po] of parsed) {
    const entries = po.items.filter(item => !item.obsolete);
    const byKey = new Map();
    const issue = (type, item, detail = '') =>
      issues.push({
        locale,
        type,
        msgid: item?.msgid ?? '',
        context: item?.msgctxt ?? null,
        references: item?.references ?? [],
        detail,
      });
    const nplurals = Number(
      PO.parsePluralForms(po.headers['Plural-Forms'] ?? '').nplurals,
    );
    if (!Number.isInteger(nplurals) || nplurals < 1)
      issue('header', null, 'Missing or invalid nplurals');
    if (po.headers.Language !== locale)
      issue('header', null, 'Language does not match catalog locale');

    for (const item of entries) {
      if (byKey.has(key(item))) issue('duplicate', item);
      byKey.set(key(item), item);
      if (!sources.has(key(item))) issue('extra', item);
    }

    let missing = 0;
    let identical = 0;

    for (const [id, original] of sources) {
      const item = byKey.get(id);

      if (!item) {
        issue('missing-entry', original);
        missing++;
        continue;
      }

      const count = original.msgid_plural ? nplurals : 1;
      const forms = item.msgstr;
      const incomplete =
        forms.length !== count || forms.some(form => !form.trim());

      if (incomplete) {
        issue(
          'missing-translation',
          item,
          `Expected ${count} nonempty form(s)`,
        );
        missing++;
      }

      if (item.flags.fuzzy) issue('fuzzy', item);
      if (forms[0] === original.msgid) identical++;

      for (let index = 0; index < forms.length; index++) {
        if (!forms[index].trim()) continue;
        const sourceForm = index === 0 ? original.msgid : original.msgid_plural;
        if (!sourceForm) continue; // Unexpected forms are already incomplete.
        if (!placeholdersMatch(sourceForm, forms[index]))
          issue('placeholders', item, `Form ${index}`);
        if (
          original.msgid_plural &&
          (sourceForm.match(/#/g)?.length ?? 0) !==
            (forms[index].match(/#/g)?.length ?? 0)
        )
          issue(
            'plural-count',
            item,
            `Form ${index}: preserve # count markers`,
          );
      }
    }

    summary.push({ locale, active: entries.length, missing, identical });
  }

  return { summary, issues };
}

export async function auditProject() {
  // Importing config does not invoke its optional translation provider.
  const { default: config } = await import('../wuchale.config.js');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const catalogs = Object.fromEntries(
    config.locales.map(locale => [
      locale,
      readFileSync(resolve(root, 'src/locales', `${locale}.po`), 'utf8'),
    ]),
  );

  return auditCatalogs(catalogs, config.sourceLocale ?? 'en');
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await auditProject();

  if (process.argv.includes('--json')) {
    console.info(JSON.stringify(result, null, 2));
  } else {
    console.info('Locale\tActive\tMissing\tIdentical to English');

    for (const { locale, active, missing, identical } of result.summary) {
      console.info(`${locale}\t${active}\t${missing}\t${identical}`);
    }

    for (const issue of result.issues.slice(0, 20)) {
      console.error(
        `${issue.locale}: ${issue.type}: ${issue.msgid} ${issue.detail}`,
      );
    }

    console.info(
      `${result.issues.length} issue(s). Use --json for every message and source reference.`,
    );
  }

  process.exitCode = result.issues.length ? 1 : 0;
}
