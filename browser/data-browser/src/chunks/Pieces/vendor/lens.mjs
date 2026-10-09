/**
 * The declarative lens interpreter for the shared lens catalog
 * (`ontology-kit/LENSES.md`): one pure, synchronous, browser-safe module that
 * reads a `LensMapping` and runs it both ways. No Node built-ins, no network,
 * no clock, so a plugin or a host can bundle it like `resolver.mjs`.
 *
 * A mapping is data, never code:
 *
 *   { version: 2, fields: [{ source, target, convert?, args?, readOnly? }] }
 *
 * - `source` and `target` are references into a row: an absolute URL is a
 *   top-level key (a property subject, as Atomic rows are keyed); a string
 *   that starts with `/` is a JSON Pointer (RFC 6901) into a nested record,
 *   such as a provider's JSON or an expanded JSON-LD node.
 * - `convert` names one of `CONVERTERS`, with `args` where it takes any.
 *   Only `identity` and `ms-to-iso` existed in v1.
 * - `readOnly: true`: the lens never writes this field's source. A changed
 *   value in a forward `put` throws; an unchanged one is ignored.
 *
 * Version 3 adds, on top of version 2 (LENSES.md, "Mapping version 3"):
 *
 * - `guards`: conditions on the source record. A record outside them is
 *   refused with `out-of-domain` by a forward `get` and `put` (on the
 *   previous record and on the result).
 * - per field `absent: "keep" | "unset" | "default"` (with `default`): what
 *   a `put` does when the view lacks a field the previous row had. `keep`
 *   (the default, and v2's only behaviour) leaves it; `unset` removes it;
 *   `default` writes `default` into the source in a forward put (and
 *   removes the target in a backward one).
 * - a one-way field is written by a backward `put` (the target computed
 *   from the source view), where v2 skips it.
 *
 * `version: 1` (ontola/atomic-server#2069's `LensMapping`, at `bab52555`) is
 * read as the same thing, with every reference a top-level key taken
 * verbatim. Differences from #2069's `lens.ts` (LENSES.md lists them too):
 *
 * - `put` writes only the fields whose value changed (Devonian's
 *   unchanged-value preservation); #2069's `lensPut` rewrote every mapped
 *   field. Results differ where a converter re-encodes an unchanged value.
 * - Converters are strict: `ms-to-iso` refuses a non-integer or out-of-range
 *   number and a string that is not a full ISO instant with a time zone
 *   (including `T24:00`, sub-millisecond digits and years outside
 *   0000-9999), with `bad-value` or `precision`; #2069 passes other types
 *   through unchanged and lets `Date.parse` return `NaN`.
 * - Values must be JSON-like (plain objects, arrays, strings, finite
 *   numbers, booleans, null; at most 64 levels deep) and are copied; #2069
 *   passes values through by reference.
 * - Unknown keys in a mapping or a field are refused; #2069 ignores them.
 * - The path tokens `__proto__`, `constructor` and `prototype` are refused,
 *   and only own properties are read or written.
 * - The parser is `parseMapping` (#2069: `parseLensMapping`) and returns a
 *   frozen mapping with parsed paths (`storedMapping` gives the plain one).
 * - Errors are `LensError`s with a stable `code`; messages are lowercase and
 *   worded differently ("unknown converter", not "Unknown converter").
 *
 * Laws, checked on each catalog lens's examples: GetPut (`put(get(s), s)`
 * equals `s`), PutGet (`get(put(v, s))` equals `v` on the mapped fields) and
 * stable put. Fields the mapping does not reference keep their value on
 * `put`, so a round trip never loses what the other side cannot see.
 */

export const LENS_MAPPING_VERSIONS = Object.freeze([1, 2, 3]);

/** A lens refused a value or an edit. `code` is stable; the message is not. */
export class LensError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LensError';
    this.code = code;
  }
}

const isPlainObject = value =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * Structural equality for JSON-like values: key order is ignored, array
 * order is not, a missing key differs from one set to undefined.
 */
export function deepEqual(a, b, depth = 0) {
  if (Object.is(a, b)) return true;
  tooDeep(depth);

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length)
      return false;

    return a.every((item, i) => deepEqual(item, b[i], depth + 1));
  }

  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;

  return keys.every(
    key => Object.hasOwn(b, key) && deepEqual(a[key], b[key], depth + 1),
  );
}

/** How deeply a value may nest, so a hostile row cannot overflow the stack. */
export const MAX_DEPTH = 64;

function tooDeep(depth) {
  if (depth > MAX_DEPTH)
    throw new LensError(
      'bad-value',
      `a value is nested deeper than ${MAX_DEPTH} levels`,
    );
}

/** Sets an own property, even one named `__proto__`. */
const own = (object, key, value) =>
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });

/**
 * A copy of a JSON-like value. Like JSON, it drops object keys whose value is
 * undefined and turns undefined array items into null; unlike JSON, anything
 * that is not JSON-like (a non-finite number, a class instance, a function)
 * is a `bad-value` instead of being converted.
 */
function clone(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string' || typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new LensError('bad-value', `${value} is not a JSON number`);

    return value;
  }

  tooDeep(depth);

  if (Array.isArray(value))
    return value.map(item => clone(item, depth + 1) ?? null);

  if (isPlainObject(value)) {
    const out = {};

    for (const key of Object.keys(value)) {
      const item = clone(value[key], depth + 1);
      if (item !== undefined) own(out, key, item);
    }

    return out;
  }

  throw new LensError('bad-value', `a ${typeof value} is not a JSON value`);
}

// ---------------------------------------------------------------- references

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:[^\s]+$/i;

/** The kind of a v2 reference, or undefined when it is neither. */
export function referenceKind(ref) {
  if (typeof ref !== 'string' || !ref) return undefined;
  if (ref.startsWith('/')) return 'pointer';
  if (ABSOLUTE.test(ref)) return 'key';

  return undefined;
}

/** A JSON Pointer's tokens, unescaped (`~1` is `/`, `~0` is `~`). */
export function pointerTokens(pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/'))
    throw new LensError('bad-reference', `"${pointer}" is not a JSON Pointer`);

  return pointer
    .slice(1)
    .split('/')
    .map(token => {
      if (/~[^01]|~$/.test(token))
        throw new LensError(
          'bad-reference',
          `"${pointer}" has a bad ~ escape (only ~0 and ~1)`,
        );

      return token.replaceAll('~1', '/').replaceAll('~0', '~');
    });
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** Path tokens that would reach an object's prototype machinery. */
const FORBIDDEN_TOKENS = new Set(['__proto__', 'constructor', 'prototype']);

/** The tokens a reference addresses: one key, or a pointer's path. */
function tokensOf(ref, version) {
  if (version === 1) return [ref];

  return referenceKind(ref) === 'pointer' ? pointerTokens(ref) : [ref];
}

function readAt(row, tokens) {
  let here = row;

  for (const token of tokens) {
    if (Array.isArray(here)) {
      if (!ARRAY_INDEX.test(token)) return undefined;
      here = here[Number(token)];
    } else if (isPlainObject(here)) {
      if (!Object.hasOwn(here, token)) return undefined;
      here = here[token];
    } else return undefined;
  }

  return here;
}

/**
 * Writes `value` at `tokens` inside `row` (mutating it), creating missing
 * containers: an array when the next token is an index, an object otherwise.
 * Siblings along the path are kept, so `/title/0/@value` keeps `@language`.
 */
function writeAt(row, tokens, value) {
  let here = row;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const last = i === tokens.length - 1;

    if (Array.isArray(here)) {
      if (!ARRAY_INDEX.test(token) || Number(token) > here.length)
        throw new LensError(
          'bad-path',
          `cannot write array index "${token}" of an array of ${here.length}`,
        );
    } else if (!isPlainObject(here))
      throw new LensError('bad-path', `cannot write into a ${typeof here}`);

    const key = Array.isArray(here) ? Number(token) : token;

    if (last) {
      own(here, key, value);

      return;
    }

    if (
      !Object.hasOwn(here, key) ||
      here[key] === undefined ||
      here[key] === null
    )
      own(here, key, ARRAY_INDEX.test(tokens[i + 1]) ? [] : {});
    here = here[key];
  }
}

/**
 * Removes the place at `tokens` inside `row` (mutating it), if it is there.
 * Only an object member can be removed: removing an array item would shift
 * every later index, so it is a `bad-path`.
 */
function removeAt(row, tokens) {
  const parent = readAt(row, tokens.slice(0, -1));
  const last = tokens[tokens.length - 1];
  if (Array.isArray(parent))
    throw new LensError('bad-path', `cannot remove array item "${last}"`);
  if (!isPlainObject(parent) || !Object.hasOwn(parent, last)) return;
  delete parent[last];

  // An object the removal emptied goes too, so `/due/date` leaves no
  // `due: {}` behind. The row itself and array items are never removed.
  for (let depth = tokens.length - 1; depth > 0; depth--) {
    const emptied = readAt(row, tokens.slice(0, depth));
    if (!isPlainObject(emptied) || Object.keys(emptied).length) return;
    const holder = readAt(row, tokens.slice(0, depth - 1));
    if (!isPlainObject(holder)) return;
    delete holder[tokens[depth - 1]];
  }
}

// ---------------------------------------------------------------- converters

/** The instants an ISO string with a four-digit year names, in UTC. */
const EARLIEST = -62167219200000; // 0000-01-01T00:00:00.000Z
const LATEST = 253402300799999; // 9999-12-31T23:59:59.999Z

const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-](\d{2}):(\d{2}))$/;

/** Whether y-m-d is a calendar date (proleptic Gregorian, any year). */
function validDate(y, mo, d) {
  const day = new Date(0);
  day.setUTCFullYear(+y, +mo - 1, +d);

  return day.getUTCDate() === +d && day.getUTCMonth() === +mo - 1;
}

/** Whether h:m(:s) is a time of day: no 24:00, no leap second. */
const validTime = (h, mi, s = '00') => +h <= 23 && +mi <= 59 && +s <= 59;

/** Epoch milliseconds of an ISO 8601 instant, refusing lost precision. */
function isoToMs(value) {
  if (typeof value !== 'string')
    throw new LensError('bad-value', `expected an ISO 8601 instant string`);
  const m = ISO_INSTANT.exec(value);
  if (!m) throw new LensError('bad-value', `"${value}" is not an ISO instant`);
  if (
    !validDate(m[1], m[2], m[3]) ||
    !validTime(m[4], m[5], m[6]) ||
    (m[9] !== undefined && !validTime(m[9], m[10]))
  )
    throw new LensError('bad-value', `"${value}" is not a valid instant`);
  if (m[7] && /[1-9]/.test(m[7].slice(3)))
    throw new LensError(
      'precision',
      `"${value}" has sub-millisecond digits an Atomic timestamp cannot hold`,
    );
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || ms < EARLIEST || ms > LATEST)
    throw new LensError(
      'bad-value',
      `"${value}" is outside the years 0000-9999 in UTC`,
    );

  return ms;
}

function checkedMs(value) {
  if (!Number.isSafeInteger(value) || value < EARLIEST || value > LATEST)
    throw new LensError(
      'bad-value',
      'expected integer epoch milliseconds within the years 0000-9999',
    );

  return value;
}

const msToIso = value => new Date(checkedMs(value)).toISOString();

function msToIsoSeconds(value) {
  if (checkedMs(value) % 1000 !== 0)
    throw new LensError(
      'precision',
      'this side keeps whole seconds; the value has milliseconds',
    );

  return new Date(value).toISOString().replace(/\.000Z$/, 'Z');
}

/**
 * A civil day or a local date-time, with no time zone. A string with `Z` or
 * an offset names an instant, whose day depends on where it is read, so it
 * is refused rather than cut at its UTC day.
 */
const LOCAL_DAY =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?$/;

function dayOf(value) {
  const m = typeof value === 'string' ? LOCAL_DAY.exec(value) : null;
  if (!m || m[1] === '0000')
    throw new LensError(
      'bad-value',
      `expected YYYY-MM-DD or a date-time without a time zone, got ${JSON.stringify(value)}`,
    );
  if (!validDate(m[1], m[2], m[3]) || (m[4] && !validTime(m[4], m[5], m[6])))
    throw new LensError('bad-value', `"${value}" is not a valid date`);

  return value.slice(0, 10);
}

function pairsOf(args) {
  const pairs = args?.pairs;
  if (!Array.isArray(pairs) || pairs.length === 0)
    throw new LensError('bad-args', 'map needs args.pairs: [[source, target]]');

  for (const pair of pairs)
    if (!Array.isArray(pair) || pair.length !== 2)
      throw new LensError('bad-args', 'every map pair is [source, target]');

  for (const side of [0, 1])
    for (let i = 0; i < pairs.length; i++)
      for (let j = i + 1; j < pairs.length; j++)
        if (deepEqual(pairs[i][side], pairs[j][side]))
          throw new LensError(
            'bad-args',
            `map is not one-to-one: ${JSON.stringify(pairs[i][side])} twice`,
          );

  return pairs;
}

function lookup(pairs, from, to, value) {
  const pair = pairs.find(p => deepEqual(p[from], value));
  if (!pair)
    throw new LensError(
      'unmapped-value',
      `${JSON.stringify(value)} is not in the lens's value map`,
    );

  return clone(pair[to]);
}

/**
 * Named converters. `get` maps a source value to a target value, `put` back.
 * A converter without `put` is one-way and only allowed on a `readOnly`
 * field. Every converter is total on its declared domain and throws a
 * `LensError` outside it: no silent coercion, no lost precision.
 */
export const CONVERTERS = Object.freeze({
  identity: Object.freeze({
    get: value => clone(value),
    put: value => clone(value),
    v1: true,
  }),
  /** Source epoch ms (an Atomic timestamp), target ISO 8601 (#2069). */
  'ms-to-iso': Object.freeze({ get: msToIso, put: isoToMs, v1: true }),
  /** Source ISO 8601 instant, target epoch ms; writes keep milliseconds. */
  'iso-to-ms': Object.freeze({ get: isoToMs, put: msToIso }),
  /** Source ISO 8601 instant in whole seconds, target epoch ms. A put with
   * milliseconds throws instead of truncating; it writes `…:SSZ`. */
  'iso-seconds-to-ms': Object.freeze({ get: isoToMs, put: msToIsoSeconds }),
  /** A one-to-one value table, `args.pairs: [[source, target], …]`. */
  map: Object.freeze({
    get: (value, args) => lookup(pairsOf(args), 0, 1, value),
    put: (value, args) => lookup(pairsOf(args), 1, 0, value),
    takesArgs: true,
  }),
  /** A date or date-time string to its civil day, `YYYY-MM-DD`. One-way. */
  'day-of': Object.freeze({ get: dayOf }),
});

// ---------------------------------------------------------------- mappings

const FIELD_KEYS = new Set(['source', 'target', 'convert', 'args', 'readOnly']);
const V3_FIELD_KEYS = new Set(['absent', 'default']);
const ABSENT = ['keep', 'unset', 'default'];
const GUARD_KEYS = new Set(['at', 'is', 'in', 'notIn', 'orAbsent']);

/** The tokens of a reference, refusing prototype-reaching ones. */
function safeTokens(ref, version, at) {
  const tokens = tokensOf(ref, version);

  for (const token of tokens)
    if (FORBIDDEN_TOKENS.has(token))
      throw new LensError(
        'bad-reference',
        `${at}: the path token "${token}" is not allowed`,
      );

  return tokens;
}

/** Reads one stored guard (version 3). */
function parseGuard(guard, i) {
  const at = `guard ${i}`;
  if (!isPlainObject(guard))
    throw new LensError('bad-mapping', `${at} is not an object`);
  const unknown = Object.keys(guard).filter(k => !GUARD_KEYS.has(k));
  if (unknown.length)
    throw new LensError('bad-mapping', `${at}: unknown ${unknown.join(', ')}`);
  if (!referenceKind(guard.at))
    throw new LensError(
      'bad-reference',
      `${at}: "at" is neither an absolute URL nor a JSON Pointer`,
    );
  const tests = ['is', 'in', 'notIn'].filter(k => guard[k] !== undefined);
  if (tests.length !== 1)
    throw new LensError(
      'bad-mapping',
      `${at} needs exactly one of "is", "in" or "notIn"`,
    );
  if (guard.is !== undefined && !['present', 'absent'].includes(guard.is))
    throw new LensError('bad-mapping', `${at}: "is" is "present" or "absent"`);

  for (const key of ['in', 'notIn'])
    if (
      guard[key] !== undefined &&
      (!Array.isArray(guard[key]) || guard[key].length === 0)
    )
      throw new LensError('bad-mapping', `${at}: "${key}" is a non-empty list`);

  if (
    guard.orAbsent !== undefined &&
    (guard.in === undefined || typeof guard.orAbsent !== 'boolean')
  )
    throw new LensError(
      'bad-mapping',
      `${at}: "orAbsent" is true or false, and only goes with "in"`,
    );

  return Object.freeze({
    ...clone(guard),
    path: Object.freeze(safeTokens(guard.at, 3, at)),
  });
}

/**
 * Whether `row` meets every guard; throws `out-of-domain` naming the first
 * one it does not. Present means neither undefined nor null.
 */
function checkGuards(parsed, row, what) {
  for (const guard of parsed.guards) {
    const value = readAt(row, guard.path);
    const present = value !== undefined && value !== null;
    let ok;
    if (guard.is === 'present') ok = present;
    else if (guard.is === 'absent') ok = !present;
    else if (guard.in !== undefined)
      ok =
        (!present && guard.orAbsent === true) ||
        (present && guard.in.some(v => deepEqual(v, value)));
    else ok = !present || !guard.notIn.some(v => deepEqual(v, value));
    if (!ok)
      throw new LensError(
        'out-of-domain',
        `${what} is outside this lens's domain: ${guard.at} is ${present ? JSON.stringify(value) : 'absent'}`,
      );
  }
}

/** Two references on one side overlap when one is a prefix of the other. */
function overlaps(a, b) {
  const n = Math.min(a.length, b.length);

  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;

  return true;
}

/** Mappings `parseMapping` returned, so they are not parsed again. */
const PARSED = new WeakSet();

/**
 * Reads a stored mapping (an object, or its JSON text) and returns it frozen
 * with each field's parsed paths, or throws a `LensError` saying why it is
 * not one. Rejects overlapping ownership as #2069 and Devonian's
 * `recordLens` do: two fields reading or writing one place would make `put`
 * order-dependent, and the laws fail.
 */
export function parseMapping(input) {
  let raw = input;

  if (typeof input === 'string') {
    try {
      raw = JSON.parse(input);
    } catch {
      throw new LensError('bad-mapping', 'a lens mapping is JSON');
    }
  }

  if (!isPlainObject(raw) || !LENS_MAPPING_VERSIONS.includes(raw.version))
    throw new LensError(
      'bad-mapping',
      `a lens mapping needs "version": ${LENS_MAPPING_VERSIONS.join(' or ')}`,
    );
  const { version, fields } = raw;
  const extra = Object.keys(raw).filter(
    k =>
      !['version', 'fields', ...(version >= 3 ? ['guards'] : [])].includes(k),
  );
  if (extra.length)
    throw new LensError('bad-mapping', `unknown keys: ${extra.join(', ')}`);
  if (!Array.isArray(fields) || fields.length === 0)
    throw new LensError(
      'bad-mapping',
      'a lens mapping needs at least one field',
    );

  const parsed = fields.map((field, i) => {
    const at = `field ${i}`;
    if (!isPlainObject(field))
      throw new LensError('bad-mapping', `${at} is not an object`);
    const unknown = Object.keys(field).filter(
      k => !FIELD_KEYS.has(k) && !(version >= 3 && V3_FIELD_KEYS.has(k)),
    );
    if (unknown.length)
      throw new LensError(
        'bad-mapping',
        `${at}: unknown ${unknown.join(', ')}`,
      );

    for (const side of ['source', 'target']) {
      const ref = field[side];
      if (typeof ref !== 'string' || !ref)
        throw new LensError('bad-mapping', `${at} needs a ${side} reference`);
      if (version >= 2 && !referenceKind(ref))
        throw new LensError(
          'bad-reference',
          `${at}: ${side} "${ref}" is neither an absolute URL nor a JSON Pointer`,
        );
    }

    const name = field.convert ?? 'identity';
    const converter = Object.hasOwn(CONVERTERS, name)
      ? CONVERTERS[name]
      : undefined;
    if (!converter || (version === 1 && !converter.v1))
      throw new LensError('bad-mapping', `unknown converter: ${name}`);
    if (field.args !== undefined && !converter.takesArgs)
      throw new LensError('bad-mapping', `${at}: ${name} takes no args`);
    if (converter.takesArgs) pairsOf(field.args);
    if (field.readOnly !== undefined && typeof field.readOnly !== 'boolean')
      throw new LensError('bad-mapping', `${at}: readOnly is true or false`);
    if (version === 1 && field.readOnly !== undefined)
      throw new LensError('bad-mapping', `${at}: readOnly needs version 2`);
    if (!converter.put && !field.readOnly)
      throw new LensError(
        'bad-mapping',
        `${at}: ${name} is one-way, so the field must be readOnly`,
      );
    if (field.absent !== undefined && !ABSENT.includes(field.absent))
      throw new LensError(
        'bad-mapping',
        `${at}: absent is "keep", "unset" or "default"`,
      );
    if ((field.absent === 'default') !== (field.default !== undefined))
      throw new LensError(
        'bad-mapping',
        `${at}: "default" goes with absent: "default", and only with it`,
      );
    const fallback = clone(field.default);

    const sourcePath = safeTokens(field.source, version, at);
    const targetPath = safeTokens(field.target, version, at);

    if (
      (field.absent === 'unset' || field.absent === 'default') &&
      [sourcePath, targetPath].some(path => {
        const last = path[path.length - 1];

        // `-` is JSON Pointer's "after the last item": an array place too.
        return ARRAY_INDEX.test(last) || last === '-';
      })
    )
      throw new LensError(
        'bad-mapping',
        `${at}: absent "${field.absent}" removes a place, and an array item cannot be removed`,
      );

    if (fallback !== undefined) {
      try {
        converter.get(fallback, field.args);
      } catch (error) {
        throw new LensError(
          'bad-mapping',
          `${at}: default is not a source value its converter accepts: ${error.message}`,
        );
      }
    }

    return Object.freeze({
      ...field,
      ...(fallback !== undefined ? { default: fallback } : {}),
      sourcePath: Object.freeze(sourcePath),
      targetPath: Object.freeze(targetPath),
      converter,
    });
  });

  for (const [side, path] of [
    ['source', 'sourcePath'],
    ['target', 'targetPath'],
  ])
    for (let i = 0; i < parsed.length; i++)
      for (let j = i + 1; j < parsed.length; j++)
        if (overlaps(parsed[i][path], parsed[j][path]))
          throw new LensError(
            'overlap',
            `Two fields ${side === 'source' ? 'read' : 'write'} ${parsed[i][side]}${parsed[i][side] === parsed[j][side] ? '' : ` and ${parsed[j][side]}`}`,
          );

  if (
    version >= 3 &&
    raw.guards !== undefined &&
    (!Array.isArray(raw.guards) || raw.guards.length === 0)
  )
    throw new LensError('bad-mapping', 'guards is a non-empty list');
  const guards = Object.freeze((raw.guards ?? []).map(parseGuard));

  const result = Object.freeze({
    version,
    fields: Object.freeze(parsed),
    guards,
  });
  PARSED.add(result);

  return result;
}

const parsedOf = mapping =>
  PARSED.has(mapping) ? mapping : parseMapping(mapping);

/** The mapping as stored: without the parsed paths, keys in a fixed order. */
export function storedMapping(mapping) {
  const { version, fields, guards } = parsedOf(mapping);
  const stored = {
    version,
    fields: fields.map(f => {
      const out = { source: f.source, target: f.target };
      if (f.convert !== undefined) out.convert = f.convert;
      if (f.args !== undefined) out.args = clone(f.args);
      if (f.readOnly !== undefined) out.readOnly = f.readOnly;
      if (f.absent !== undefined) out.absent = f.absent;
      if (f.default !== undefined) out.default = clone(f.default);

      return out;
    }),
  };

  if (guards.length)
    stored.guards = guards.map(g => {
      const out = { at: g.at };

      for (const key of ['is', 'in', 'notIn', 'orAbsent'])
        if (g[key] !== undefined) out[key] = clone(g[key]);

      return out;
    });

  return stored;
}

/**
 * The row as the other side sees it. `forward` reads the source shape and
 * produces the target shape; `backward` the reverse, skipping one-way
 * fields (they have no inverse). Unmapped properties are dropped; a mapped
 * place that is absent in the row is absent in the result.
 */
export function lensGet(mapping, row, direction = 'forward') {
  const parsed = parsedOf(mapping);
  const { fields } = parsed;
  if (direction === 'forward') checkGuards(parsed, row, 'the record');
  const out = {};

  for (const field of fields) {
    const forward = direction === 'forward';
    if (!forward && !field.converter.put) continue;
    const value = readAt(row, forward ? field.sourcePath : field.targetPath);
    if (value === undefined) continue;
    const convert = forward ? field.converter.get : field.converter.put;
    writeAt(
      out,
      forward ? field.targetPath : field.sourcePath,
      convert(value, field.args),
    );
  }

  return out;
}

/**
 * A changed view written back onto the row it came from. Only fields whose
 * view value differs from what `get` reads from `previous` are written, so
 * unchanged values keep their exact representation; a field absent from the
 * view is left alone (removal is not expressible in v2). Places the mapping
 * does not reference keep their value. Throws `LensError('read-only')` on a
 * changed read-only field in the forward direction.
 */
export function lensPut(mapping, view, previous, direction = 'forward') {
  const parsed = parsedOf(mapping);
  const forward = direction === 'forward';
  // Backward, the view is the provider record, so it must be in the domain.
  if (!forward) checkGuards(parsed, view, 'the record');
  const current = lensGet(parsed, previous, direction);
  const next = clone(previous) ?? {};

  for (const field of parsed.fields) {
    const viewPath = forward ? field.targetPath : field.sourcePath;
    const rowPath = forward ? field.sourcePath : field.targetPath;
    const wanted = readAt(view, viewPath);
    const removes = field.absent === 'unset' || field.absent === 'default';

    // A one-way field has no inverse, so `current` cannot hold it: from
    // version 3 a backward put computes the target from the source view.
    if (!forward && !field.converter.put) {
      if (parsed.version < 3) continue;

      if (wanted === undefined) {
        if (removes) removeAt(next, rowPath);
      } else {
        const value = field.converter.get(wanted, field.args);
        if (!deepEqual(value, readAt(previous, rowPath)))
          writeAt(next, rowPath, value);
      }

      continue;
    }

    const had = readAt(current, viewPath);

    if (wanted === undefined) {
      if (!removes || had === undefined || (forward && field.readOnly))
        continue;
      if (forward && field.absent === 'default')
        writeAt(next, rowPath, clone(field.default));
      else removeAt(next, rowPath);
      continue;
    }

    if (deepEqual(wanted, had)) continue;
    if (forward && field.readOnly)
      throw new LensError(
        'read-only',
        `${field.target} is read-only through this lens: ${field.source} is never written`,
      );
    const convert = forward ? field.converter.put : field.converter.get;
    writeAt(next, rowPath, convert(wanted, field.args));
  }

  if (forward) checkGuards(parsed, next, 'the written record');

  return next;
}

/** Runs `get` along a chain of `{ mapping, direction }` steps (≤ 2 in a host). */
export function getAlongPath(steps, row) {
  return steps.reduce(
    (current, step) => lensGet(step.mapping, current, step.direction),
    row,
  );
}

/**
 * The three example-based laws for one lens and one row, as a list of
 * failures (empty when all hold): GetPut, and with `desired` (a view in the
 * other shape) PutGet and stable put. `backward` treats `row` as the
 * target shape. Exceptions propagate.
 */
export function lawProblems(mapping, row, desired, direction = 'forward') {
  const parsed = parsedOf(mapping);
  const forward = direction === 'forward';
  const at = forward ? '' : ' (backward)';
  const problems = [];
  const view = lensGet(parsed, row, direction);

  // Backwards, the view is built from a target-shaped row and lacks every
  // provider place no field maps (an id, a type); when that leaves it
  // outside the guards, put refuses it, and GetPut says nothing about it.
  // PutGet and stable put for `desired` are still checked below.
  let getPutApplies = true;

  if (!forward) {
    try {
      checkGuards(parsed, view, 'the view');
    } catch (error) {
      if (!(error instanceof LensError) || error.code !== 'out-of-domain')
        throw error;
      getPutApplies = false;
    }
  }

  // Backwards, a one-way field cannot appear in the view (it has no
  // inverse), so its target place is left out of the comparison: under
  // absent "unset" or "default" a backward put removes it, so GetPut does
  // not hold there (LENSES.md, "Mapping version 3").

  const comparable = value => {
    if (forward) return value;
    const copy = clone(value);

    for (const field of parsed.fields)
      if (!field.converter.put) removeAt(copy, field.targetPath);

    return copy;
  };

  if (
    getPutApplies &&
    !deepEqual(
      comparable(lensPut(parsed, view, row, direction)),
      comparable(row),
    )
  )
    problems.push(`GetPut${at}: putting the unchanged view changed the row`);

  if (desired !== undefined) {
    const updated = lensPut(parsed, desired, row, direction);
    const got = lensGet(parsed, updated, direction);

    for (const field of parsed.fields) {
      // Backwards a one-way field has no inverse to read back through, so
      // check what the put wrote instead: the target `get` gives for the
      // view's source value (or nothing, when the view lacks it and the
      // field removes).
      if (!forward && !field.converter.put) {
        const source = readAt(desired, field.sourcePath);
        const written = readAt(updated, field.targetPath);
        const removes = field.absent === 'unset' || field.absent === 'default';
        if (
          source !== undefined
            ? !deepEqual(written, field.converter.get(source, field.args))
            : removes && written !== undefined
        )
          problems.push(
            `PutGet${at}: ${field.target} is not what ${field.source} gives`,
          );
        continue;
      }

      const path = forward ? field.targetPath : field.sourcePath;
      const want = readAt(desired, path);
      const back = readAt(got, path);
      const name = forward ? field.target : field.source;
      if (want !== undefined && !deepEqual(back, want))
        problems.push(`PutGet${at}: ${name} did not read back as written`);
      // A field the view leaves out under absent "unset" must read back
      // absent; under "default" it reads back as the default's value.
      else if (
        want === undefined &&
        field.absent === 'unset' &&
        !(forward && field.readOnly) &&
        back !== undefined
      )
        problems.push(`PutGet${at}: ${name} was left out but reads back`);
    }

    if (!deepEqual(lensPut(parsed, desired, updated, direction), updated))
      problems.push(`stable put${at}: putting the same view twice changed it`);
  }

  return problems;
}

// ---------------------------------------------------------------- catalog

/**
 * The string a lens endpoint is known by in an offer search (#2069's
 * `source`/`target`): a class's subject, or for a provider record or an RDF
 * node, a provisional key until the produced-class declaration (pieces.md
 * I1, O8) gives derived classes a subject. LENSES.md, "Endpoints".
 */
export function endpointKey(endpoint) {
  if (typeof endpoint?.class === 'string') return endpoint.class;
  const r = endpoint?.record;
  if (r) return `record:${r.openapi ?? r.provider}#${r.resource}`;
  if (typeof endpoint?.rdf === 'string') return `rdf:${endpoint.rdf}`;
  throw new LensError('bad-endpoint', 'an endpoint is a class, record or rdf');
}

/**
 * A published catalog lens in the shape #2069's `loadLensCatalog()` returns
 * (`CatalogLens`), plus `mappingVersion` so a v1-only host can skip what it
 * cannot run instead of failing.
 */
export function catalogLensInfo(lens) {
  return {
    subject: lens['@id'],
    name: lens.name,
    source: endpointKey(lens.source),
    target: endpointKey(lens.target),
    mapping: lens.mapping,
    mappingVersion: lens.mapping.version,
  };
}

/**
 * A lens between two classes as a `resolver.mjs` lens hook (`{ from, to,
 * read, write }`), so a view's resolver and an integration's sync run the
 * same interpreter (pieces.md L4). Only for lenses whose endpoints are both
 * classes, keyed by property subjects.
 */
export function resolverLens(lens) {
  if (
    typeof lens.source?.class !== 'string' ||
    typeof lens.target?.class !== 'string'
  )
    throw new LensError(
      'bad-endpoint',
      'resolverLens needs two class endpoints',
    );
  const mapping = parseMapping(lens.mapping);

  return {
    from: lens.source.class,
    to: lens.target.class,
    read: row => lensGet(mapping, row),
    write: (patch, row) => {
      const next = lensPut(mapping, patch, row);
      const changed = {};

      for (const key of Object.keys(next))
        if (!deepEqual(next[key], row[key])) changed[key] = next[key];

      return changed;
    },
  };
}
