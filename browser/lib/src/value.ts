import { JSONADParser } from './parse.js';
import type { Resource } from './resource.js';

export type JSONPrimitive = string | number | boolean;
export type JSONValue = JSONPrimitive | JSONObject | JSONArray | undefined;
export type JSONObject = { [key: string]: JSONValue };
export type JSONArray = Array<JSONValue>;

export type AtomicValue = JSONValue | Uint8Array;

/**
 * Tries to convert the value as an array of resources, which can be both URLs
 * or Nested Resources. Throws an error when fails
 */
export function valToArray(val?: AtomicValue): JSONArray {
  if (val === undefined) {
    throw new Error(`Not an array: ${val}, is ${typeof val}`);
  }

  if (Array.isArray(val)) {
    return val;
  }

  throw new Error(`Not an array: ${val}, is a ${typeof val}`);
}

/** Tries to make a boolean from this value. Throws if it is not a boolean. */
export function valToBoolean(val?: AtomicValue): boolean {
  if (typeof val !== 'boolean') {
    throw new Error(`Not a boolean: ${val}, is a ${typeof val}`);
  }

  return val;
}

/**
 * Tries to convert the value (timestamp or date) to a JS Date. Throws an error
 * when fails.
 */
export function valToDate(val?: AtomicValue): Date {
  // If it's a unix epoch timestamp...
  if (typeof val === 'number') {
    const date = new Date(0); // The 0 there is the key, which sets the date to the epoch
    date.setUTCMilliseconds(val);

    return date;
  }

  if (typeof val === 'string') {
    return new Date(val.toString());
  }

  throw new Error(`Cannot be converted into Date: ${val}, is a ${typeof val}`);
}

/** Returns a number of the value, or throws an error */
export function valToNumber(val?: AtomicValue): number {
  if (typeof val !== 'number') {
    throw new Error(`Not a number: ${val}, is a ${typeof val}`);
  }

  return val;
}

/** Returns a default string representation of the value. */
export function valToString(val: AtomicValue): string {
  // val && val.toString();
  return val?.toString() ?? 'undefined';
}

/** Returns either the URL of the resource, or the NestedResource itself. */
export function valToResource(val: AtomicValue): string | Resource {
  if (typeof val === 'string') {
    return val;
  }

  if (val instanceof Date) {
    throw new Error(`Not a resource: ${val}, is a Date`);
  }

  if (Array.isArray(val)) {
    throw new Error(`Not a resource: ${val}, is an Array`);
  }

  if (typeof val === 'object') {
    const parser = new JSONADParser();
    const [resource] = parser.parse(val as JSONObject, 'nested-resource');

    return resource;
  }

  if (typeof val !== 'object') {
    throw new Error(`Not a resource: ${val}, is a ${typeof val}`);
  }

  throw new Error(`Not a resource: ${val}, is a ${typeof val}`);
}

export const isJSONObject = (value: JSONValue): value is JSONObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

