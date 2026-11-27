#!/usr/bin/env node
// Translations of the Flutter packages, the same model as the web app's wuchale:
// the English sentence in the code is the key (msgid).
//
//   node tools/flutter-i18n.mjs          extract, update the .po files, regenerate
//   node tools/flutter-i18n.mjs --check  fail if any of that is out of date
//
// Reads `t('...')` and `tOf(context)('...')` calls in packages/*/lib/**/*.dart,
// keeps packages/atomic_flutter/locales/<lang>.po (new entries are seeded from
// browser/resource-ui/src/locales/<lang>.po when the web app has the same
// sentence, else left empty = English; unused ones become obsolete `#~`) and
// writes packages/atomic_flutter/lib/src/translations.g.dart (committed:
// the packages are git dependencies, so there is no build step).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LANGS = ['nl', 'de', 'fr', 'es', 'id'];
const PO_DIR = path.join(root, 'packages/atomic_flutter/locales');
const WEB_DIR = path.join(root, 'browser/resource-ui/src/locales');
const GENERATED = path.join(root, 'packages/atomic_flutter/lib/src/translations.g.dart');
const check = process.argv.includes('--check');
const errors = [];

// --- Extraction ------------------------------------------------------------

const ESC = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v' };

/** Finds the `t('...')` calls of one Dart file: [{ msgid, line }]. */
function extract(src, file) {
  const found = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;
  const isIdent = (c) => c !== undefined && /[\w$]/.test(c);

  // Reads a string literal at i; returns { value, end, dynamic }. Interpolated
  // expressions are scanned too, so a t() inside "${...}" is found.
  function literal(i) {
    let raw = false;
    if (src[i] === 'r' && (src[i + 1] === "'" || src[i + 1] === '"')) { raw = true; i++; }
    const q = src[i];
    const triple = src.startsWith(q.repeat(3), i);
    const close = triple ? q.repeat(3) : q;
    i += close.length;
    let value = '';
    let dynamic = false;
    while (i < src.length && !src.startsWith(close, i)) {
      const c = src[i];
      if (!raw && c === '\\') {
        const n = src[i + 1];
        if (n === 'u' && src[i + 2] === '{') {
          const e = src.indexOf('}', i);
          value += String.fromCodePoint(parseInt(src.slice(i + 3, e), 16));
          i = e + 1;
        } else if (n === 'u') {
          value += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        } else if (n === 'x') {
          value += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
          i += 4;
        } else {
          value += ESC[n] ?? n;
          i += 2;
        }
      } else if (!raw && c === '$' && src[i + 1] === '{') {
        dynamic = true;
        i = code(i + 2, '}');
      } else if (!raw && c === '$' && /[A-Za-z_]/.test(src[i + 1] ?? '')) {
        dynamic = true;
        i++;
        while (isIdent(src[i])) i++;
      } else {
        value += c;
        i++;
      }
    }
    return { value, end: i + close.length, dynamic };
  }

  // A call's first argument: adjacent literals concatenate. Returns the end.
  function firstArg(i, at) {
    while (/\s/.test(src[i])) i++;
    if (!/['"]/.test(src[i]) && !(src[i] === 'r' && /['"]/.test(src[i + 1]))) {
      return i; // not a translation call (a local named t), or a variable: skipped
    }
    let value = '';
    let dynamic = false;
    for (;;) {
      const lit = literal(i);
      value += lit.value;
      dynamic ||= lit.dynamic;
      i = lit.end;
      let j = i;
      while (/\s/.test(src[j])) j++;
      if (/['"]/.test(src[j])) i = j; else break;
    }
    if (dynamic) errors.push(`${file}:${lineAt(at)}: t() argument must not interpolate: use {name} placeholders`);
    else found.push({ msgid: value, line: lineAt(at) });
    return i;
  }

  // Scans code from i until the unmatched `closer` (or the end); returns the
  // index after it.
  function code(i, closer) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; continue; }
      if (c === "'" || c === '"' || (c === 'r' && /['"]/.test(src[i + 1]) && !isIdent(src[i - 1]))) {
        i = literal(i).end;
        continue;
      }
      if (closer && c === (closer === '}' ? '{' : '(')) depth++;
      if (closer && c === closer) {
        if (depth === 0) return i + 1;
        depth--;
      }
      if (/[A-Za-z_$]/.test(c) && !isIdent(src[i - 1]) && (src[i - 1] !== '.' || src.slice(i - 3, i) === 'ui.')) {
        let e = i;
        while (isIdent(src[e])) e++;
        const word = src.slice(i, e);
        let j = e;
        while (/\s/.test(src[j])) j++;
        if (word === 't' && src[j] === '(') {
          i = firstArg(j + 1, i);
          continue;
        }
        if (word === 'tOf' && src[e] === '(') {
          const afterCtx = code(e + 1, ')');
          let k = afterCtx;
          while (/\s/.test(src[k])) k++;
          if (src[k] === '(') { i = firstArg(k + 1, i); continue; }
          i = afterCtx;
          continue;
        }
        i = e;
        continue;
      }
      i++;
    }
    return i;
  }

  code(0, null);
  return found;
}

function dartFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) dartFiles(p, out);
    else if (e.name.endsWith('.dart') && !p.endsWith('translations.g.dart')) out.push(p);
  }
  return out;
}

/** msgid -> sorted list of the files that use it (in order of first use). */
function usedMessages() {
  const used = new Map();
  const pkgs = fs.readdirSync(path.join(root, 'packages')).sort();
  for (const pkg of pkgs) {
    const lib = path.join(root, 'packages', pkg, 'lib');
    if (!fs.existsSync(lib)) continue;
    for (const file of dartFiles(lib)) {
      const rel = path.relative(root, file);
      for (const { msgid } of extract(fs.readFileSync(file, 'utf8'), rel)) {
        if (!used.has(msgid)) used.set(msgid, new Set());
        used.get(msgid).add(file);
      }
    }
  }
  return used;
}

// --- .po files -------------------------------------------------------------

const unq = (s) => s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c));
const q = (s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"';

/** Parses a .po file: { header, entries: Map<msgid, { msgstr, obsolete, fuzzy }> }. */
function parsePo(text) {
  const entries = new Map();
  let header = null;
  for (const block of text.split(/\n{2,}/)) {
    let obsolete = false;
    let fuzzy = false;
    let plural = false;
    let id = null;
    let str = null;
    let cur = null;
    for (let line of block.split('\n')) {
      if (line.startsWith('#~')) { obsolete = true; line = line.slice(2).trim(); }
      else if (line.startsWith('#,')) { fuzzy ||= line.includes('fuzzy'); continue; }
      else if (line.startsWith('#')) continue;
      if (line.startsWith('msgid_plural')) { plural = true; cur = null; }
      else if (line.startsWith('msgid ')) { id = unq(line.slice(6)); cur = 'id'; }
      else if (line.startsWith('msgstr ')) { str = unq(line.slice(7)); cur = 'str'; }
      else if (line.startsWith('msgstr[')) { plural = true; cur = null; }
      else if (line.startsWith('"')) {
        if (cur === 'id') id += unq(line);
        else if (cur === 'str') str += unq(line);
      }
    }
    if (id === null || plural) continue;
    if (id === '') header = str;
    else entries.set(id, { msgstr: str ?? '', obsolete, fuzzy });
  }
  return { header, entries };
}

function readPo(file) {
  return fs.existsSync(file) ? parsePo(fs.readFileSync(file, 'utf8')) : { header: null, entries: new Map() };
}

const defaultHeader = (lang) =>
  `Plural-Forms: nplurals=2; plural=(n != 1);\nSource-Language: en\nLanguage: ${lang}\nMIME-Version: 1.0\nContent-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: 8bit\n`;

function formatPo(lang, header, used, entries) {
  const head = (header ?? defaultHeader(lang)).split(/(?<=\n)/).map(q).join('\n');
  const out = [`msgid ""\nmsgstr ""\n${head}\n`];
  const poDir = PO_DIR;
  for (const [msgid, files] of used) {
    const refs = [...files].map((f) => path.relative(poDir, f).split(path.sep).join('/')).sort();
    out.push(`${refs.map((r) => `#: ${r}\n`).join('')}msgid ${q(msgid)}\nmsgstr ${q(entries.get(msgid).msgstr)}\n`);
  }
  for (const [msgid, e] of entries) {
    if (used.has(msgid)) continue;
    out.push(`#~ msgid ${q(msgid)}\n#~ msgstr ${q(e.msgstr)}\n`);
  }
  return out.join('\n');
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

// --- Generated Dart --------------------------------------------------------

const dq = (s) => "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$').replace(/\n/g, '\\n') + "'";

function formatDart(tables) {
  const out = [
    '// GENERATED by tools/flutter-i18n.mjs from locales/*.po. Do not edit.',
    '// ignore_for_file: lines_longer_than_80_chars',
    '',
    '/// Translations by language code, then by English sentence. A sentence',
    '/// without an entry stays English.',
    'const Map<String, Map<String, String>> kTranslations = {',
  ];
  for (const lang of LANGS) {
    const rows = tables[lang];
    if (!rows.length) { out.push(`  '${lang}': {},`); continue; }
    out.push(`  '${lang}': {`);
    for (const [k, v] of rows) {
      const line = `    ${dq(k)}: ${dq(v)},`;
      out.push(line.length <= 80 ? line : `    ${dq(k)}:\n        ${dq(v)},`);
    }
    out.push('  },');
  }
  out.push('};', '');
  return out.join('\n');
}

// --- Main ------------------------------------------------------------------

const used = usedMessages();
const outputs = new Map(); // file -> text
const tables = {};
const seeded = {};

for (const lang of LANGS) {
  const file = path.join(PO_DIR, `${lang}.po`);
  const po = readPo(file);
  const web = readPo(path.join(WEB_DIR, `${lang}.po`));
  const entries = new Map(po.entries);
  seeded[lang] = 0;
  for (const msgid of used.keys()) {
    const existing = entries.get(msgid);
    if (existing) {
      entries.set(msgid, { ...existing, obsolete: false });
      continue;
    }
    const w = web.entries.get(msgid);
    const seed = w && !w.obsolete && !w.fuzzy && w.msgstr && placeholders(w.msgstr) === placeholders(msgid) ? w.msgstr : '';
    if (seed) seeded[lang]++;
    entries.set(msgid, { msgstr: seed, obsolete: false });
  }
  outputs.set(file, formatPo(lang, po.header, used, entries));
  tables[lang] = [...used.keys()].filter((m) => entries.get(m).msgstr).map((m) => [m, entries.get(m).msgstr]);

  for (const [msgid, e] of entries) {
    if (used.has(msgid) && e.msgstr && placeholders(e.msgstr) !== placeholders(msgid)) {
      errors.push(`${lang}.po: placeholders differ from the English: ${JSON.stringify(msgid)}`);
    }
  }
  if (lang === 'nl') {
    for (const [msgid, e] of entries) {
      if (/[—–]/.test(e.msgstr)) errors.push(`nl.po: Dutch never uses an em dash or an en dash: ${JSON.stringify(e.msgstr)}`);
    }
  }
}
outputs.set(GENERATED, formatDart(tables));

if (check) {
  for (const [file, text] of outputs) {
    const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (now !== text) errors.push(`${path.relative(root, file)} is out of date`);
  }
  if (errors.length) {
    console.error(errors.join('\n'));
    console.error('Run `node tools/flutter-i18n.mjs` and commit the result.');
    process.exit(1);
  }
  console.log(`flutter-i18n: ${used.size} messages, up to date`);
} else {
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
  }
  fs.mkdirSync(PO_DIR, { recursive: true });
  for (const [file, text] of outputs) fs.writeFileSync(file, text);
  const filled = (l) => tables[l].length;
  console.log(
    `flutter-i18n: ${used.size} messages; translated ` +
      LANGS.map((l) => `${l} ${filled(l)} (${seeded[l]} seeded from web)`).join(', '),
  );
}
