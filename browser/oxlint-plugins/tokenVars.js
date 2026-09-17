/**
 * Lints `var(--x)` against the properties that are actually declared.
 *
 * A custom property is a string everywhere it appears, so `var(--color-bgg)`
 * typechecks, lints clean, renders, and silently does nothing: the declaration
 * just fails to apply and the element keeps whatever it inherited. That is the
 * one real cost of reading design values from CSS instead of from a typed theme
 * object, and this is the feedback loop that pays it back.
 *
 * It is not a hole the theme object used to cover. The theme only ever
 * type-checked *its own member names*; a value in an inline style, a `.css`
 * file, or a component-local `--var` was an unchecked string either way. Both
 * bugs this first caught lived in exactly those places and predated the move
 * off the theme: `var(--color-bg1)` on the selected search result (the token is
 * `--color-bg-subtle`, so there was no highlight) and `var(--dark-color)` for
 * the tag hover shadow (declared twenty lines above as `--tag-dark-color`).
 *
 * A rule rather than a test because this wants to be a squiggle while you type
 * and a pre-commit failure, not a line in a test report.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Only the data-browser has a token layer; the other packages have no tokens. */
const SCOPE = ['data-browser/src/', 'data-browser\\src\\'];

/**
 * Properties something other than our source declares. A `var()` for one of
 * these is correct even though nothing in `src/` declares it.
 */
const EXTERNAL = [
  // Radix UI writes these onto its own popper elements.
  /^--radix-/,
  // Written by `useKeyboardInset` onto the document element.
  /^--keyboard-inset$/,
];

/** `--x: value`, `'--x':` as an object key, and `--x${...}` families. */
const DECLARATION = /(--[\w-]+)\s*['"`]?\s*\]?\s*:|(--[\w-]+)\$\{/g;
/** A `CSSVar` instance owns a suffixed property nothing references literally. */
const CSS_VAR = /new CSSVar\(\s*['"]([\w-]+)['"]/g;
/**
 * `var(--x)` with no fallback. `var(--x, 0)` says what to do when the property
 * is absent, so an undeclared name there is a deliberate hook, not a typo.
 */
const REFERENCE = /var\(\s*(--[\w-]+)\s*([,)])/g;

/**
 * Comments, so prose about a token does not read as a reference. Line comments
 * only when they start a line, so a `https://` in a template literal survives.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Replace with spaces so every remaining offset still points at the source. */
function blank(match) {
  return match.replace(/[^\n]/g, ' ');
}

function collect(regex, text, into) {
  regex.lastIndex = 0;

  for (let m = regex.exec(text); m; m = regex.exec(text)) {
    for (const name of m.slice(1)) {
      if (name) into.add(name.startsWith('--') ? name : '--' + name);
    }
  }
}

function sourceFiles(dir) {
  return readdirSync(dir).flatMap(entry => {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      return entry === 'locales' ? [] : sourceFiles(full);
    }

    return /\.(ts|tsx|css)$/.test(entry) ? [full] : [];
  });
}

/**
 * Every property declared anywhere in the app, collected once per lint run.
 *
 * The whole tree rather than just `tokens.css`, because a component-local
 * property is legitimately declared in one file and read in another:
 * `--template-color-bg1` is set on a wrapper in `TemplateListItem` and read by
 * the SVG in `websiteImage`. A per-file rule would call that a typo.
 */
const declaredAnywhere = (() => {
  const tokens = new Set();

  try {
    for (const file of sourceFiles(join(here, '../data-browser/src'))) {
      const text = stripComments(readFileSync(file, 'utf-8'));

      collect(DECLARATION, text, tokens);
      collect(CSS_VAR, text, tokens);
    }
  } catch {
    // Left empty on purpose: failing to read the tree would make every `var()`
    // an error, which is a worse failure than not checking. The guard below on
    // an empty set turns the rule off instead.
  }

  return tokens;
})();

const inScope = filename => SCOPE.some(part => filename.includes(part));

const plugin = {
  meta: { name: 'token-vars' },
  rules: {
    'no-unknown-custom-property': {
      meta: {
        type: 'problem',
        docs: {
          description:
            'Every var(--x) must name a custom property that is declared',
        },
      },
      create(context) {
        if (declaredAnywhere.size === 0 || !inScope(context.filename)) {
          return {};
        }

        return {
          // Once per file, on the raw text: a custom property can appear in a
          // template literal, a plain string, or a `.css` file that has no AST
          // here, so there is no single node type to hook.
          Program() {
            const text = stripComments(context.sourceCode.text);

            REFERENCE.lastIndex = 0;

            for (let m = REFERENCE.exec(text); m; m = REFERENCE.exec(text)) {
              const [, name, next] = m;

              if (next === ',' || declaredAnywhere.has(name)) continue;
              if (EXTERNAL.some(rule => rule.test(name))) continue;

              const start = m.index + m[0].indexOf(name);

              context.report({
                message: `'${name}' is not a declared custom property, so this declaration will be dropped. Add it to styles/tokens.css, or give the var() a fallback if it is meant to be optional.`,
                node: { range: [start, start + name.length] },
              });
            }
          },
        };
      },
    },
  },
};

export default plugin;
