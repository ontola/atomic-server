/** Each possible Atomic Datatype. See https://atomicdata.dev/collections/datatype */

import { Client } from './index.js';
import type { AtomicValue } from './value.js';

// TODO: use strings from `./urls`, requires TS fix: https://github.com/microsoft/TypeScript/issues/40793
export enum Datatype {
  /** A Resource - either a URL string or a Nested Resource */
  ATOMIC_URL = 'https://atomicdata.dev/datatypes/atomicURL',
  /** True / false */
  BOOLEAN = 'https://atomicdata.dev/datatypes/boolean',
  /** ISO date YYYY-MM-DD */
  DATE = 'https://atomicdata.dev/datatypes/date',
  /** Floating point number (number with comma) */
  FLOAT = 'https://atomicdata.dev/datatypes/float',
  INTEGER = 'https://atomicdata.dev/datatypes/integer',
  /** UTF-8 Markdown string */
  MARKDOWN = 'https://atomicdata.dev/datatypes/markdown',
  /** Array of Resources and */
  RESOURCEARRAY = 'https://atomicdata.dev/datatypes/resourceArray',
  /** String with only letters, numbers and dashes in between */
  SLUG = 'https://atomicdata.dev/datatypes/slug',
  STRING = 'https://atomicdata.dev/datatypes/string',
  /** Milliseconds since unix epoch */
  TIMESTAMP = 'https://atomicdata.dev/datatypes/timestamp',
  /** JSON object */
  JSON = 'https://atomicdata.dev/datatypes/json',
  /** URI */
  URI = 'https://atomicdata.dev/datatypes/uri',
  LORODOC = 'https://atomicdata.dev/datatypes/lorodoc',
  UNKNOWN = 'unknown-datatype',
}

const validDatatypes = Object.values(Datatype) as string[];

/** Convert a URL to a Datatype */
export const datatypeFromUrl = (url: string): Datatype => {
  if (validDatatypes.includes(url)) {
    return url as Datatype;
  }

  return Datatype.UNKNOWN;
};

const slug_regex = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// https://stackoverflow.com/a/22061879/2502163
const dateStringRegex = /^\d{4}-(0[1-9]|1[012])-(0[1-9]|[12][0-9]|3[01])$/;

export interface ArrayError extends Error {
  index?: number;
}

/** Validates a JSON Value using a Datatype. Throws an error if things are wrong. */
export const validateDatatype = (
  value: AtomicValue,
  datatype: Datatype,
): void => {
  let err: null | string = null;

  if (value === undefined) {
    throw new Error(`Value is undefined, expected ${datatype}`);
  }

  switch (datatype) {
    case Datatype.STRING: {
      if (!isString(value)) {
        err = 'Not a string';
        break;
      }

      break;
    }

    case Datatype.MARKDOWN: {
      if (!isString(value)) {
        err = 'Not a string';
        break;
      }

      break;
    }

    case Datatype.SLUG: {
      if (!isString(value)) {
        err = 'Not a slug, not even a string';
        break;
      }

      if (value.match(slug_regex) === null) {
        err =
          'Not a valid slug. Only lowercase letters and numbers with dashes `-` between them';
      }

      break;
    }

    case Datatype.ATOMIC_URL: {
      if (!isString(value)) {
        err = 'Not a string. Should be a URL';
        break;
      }

      Client.tryValidSubject(value);
      break;
    }

    case Datatype.RESOURCEARRAY: {
      if (!Array.isArray(value)) {
        err = 'Not an array';
        break;
      }

      value.map((item, index) => {
        try {
          Client.tryValidSubject(item as string);
        } catch (e) {
          const arrError: ArrayError = new Error(`Invalid URL`);
          arrError.index = index;
          throw arrError;
        }
      });
      break;
    }

    case Datatype.INTEGER: {
      if (!isNumber(value)) {
        err = 'Not a number';
        break;
      }

      if (value % 1 !== 0) {
        err = 'Not an integer';
      }

      break;
    }

    case Datatype.FLOAT: {
      if (!isNumber(value)) {
        err = 'Not a number';
        break;
      }

      break;
    }

    case Datatype.BOOLEAN: {
      if (typeof value !== 'boolean') {
        err = 'Not a boolean';
        break;
      }

      break;
    }

    case Datatype.DATE: {
      if (!isString(value)) {
        err = 'Not a string';
        break;
      }

      if (value.match(dateStringRegex) === null) {
        err = 'Not a date string: YYYY-MM-DD';
      }

      break;
    }

    case Datatype.TIMESTAMP: {
      if (!isNumber(value)) {
        err = 'Not a number';
        break;
      }

      break;
    }

    case Datatype.JSON: {
      try {
        JSON.stringify(value);
      } catch (e) {
        err = 'Not valid JSON';
      }

      break;
    }

    case Datatype.URI: {
      try {
        new URL(value as string);
      } catch (e) {
        err = 'Not a valid URI';
      }

      break;
    }

    case Datatype.LORODOC: {
      if (!(value instanceof Uint8Array)) {
        err = 'Not a Loro document (expected Uint8Array)';
        break;
      }

      break;
    }

    default: {
      throw new Error(`Unsupported datatype: ${datatype}`);
    }
  }

  if (err !== null) {
    throw new Error(err);
  }
};

export function isString(val: AtomicValue): val is string {
  return typeof val === 'string';
}

export function isNumber(val: AtomicValue): val is number {
  return typeof val === 'number';
}

export const reverseDatatypeMapping = {
  [Datatype.STRING]: 'String',
  [Datatype.SLUG]: 'Slug',
  [Datatype.MARKDOWN]: 'Markdown',
  [Datatype.URI]: 'URI',
  [Datatype.JSON]: 'JSON',
  [Datatype.INTEGER]: 'Integer',
  [Datatype.FLOAT]: 'Float',
  [Datatype.BOOLEAN]: 'Boolean',
  [Datatype.DATE]: 'Date',
  [Datatype.TIMESTAMP]: 'Timestamp',
  [Datatype.ATOMIC_URL]: 'Resource',
  [Datatype.RESOURCEARRAY]: 'ResourceArray',
  [Datatype.LORODOC]: 'LoroDoc',
  [Datatype.UNKNOWN]: 'Unknown',
};
