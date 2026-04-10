import { AtomicError } from './error.js';
import { Client } from './index.js';
import { server } from './ontologies/server.js';
import { Resource, unknownSubject } from './resource.js';
import {
  type JSONObject,
  type JSONValue,
  type AtomicValue,
  isJSONObject,
} from './value.js';
import { decodeB64 } from './base64.js';

/**
 * Parses a JSON-AD object or array into resources. Create a new instance each time you need to parse a json-ad string.
 */
export class JSONADParser {
  public parse(json: unknown, subject: string = unknownSubject): Resource[] {
    if (Array.isArray(json)) {
      // Array responses contain multiple resources (e.g. search with include=true).
      // Each item has its own @id. Parse without enforcing a subject match — the
      // caller (fetchResourceHTTP) will find the right one by subject.
      return json.flatMap(item =>
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? [this.parseObject(item as JSONObject)]
          : [],
      );
    }

    if (typeof json !== 'object' || json === null) {
      throw new Error('JSON-AD must be an object or array');
    }

    return [this.parseObject(json as JSONObject, subject)];
  }

  private parseObject(json: JSONObject, subject?: string): Resource {
    const resource = new Resource(subject ?? unknownSubject);

    try {
      const hydratedValues: [string, AtomicValue][] = [];

      for (const [key, value] of Object.entries(json)) {
        if (key === '@id') {
          if (typeof value !== 'string') {
            throw new Error('Expected @id to be a string');
          }

          // Only enforce subject match when a specific subject was requested
          if (subject && subject !== unknownSubject && value !== subject) {
            const subjectNoParams = Client.removeQueryParamsFromURL(subject);
            const valueNoParams = Client.removeQueryParamsFromURL(value);

            if (subjectNoParams !== valueNoParams) {
              throw new Error(
                `Resource has wrong subject in @id. Received subject was ${value}, expected ${resource.subject}.`,
              );
            }
          }

          resource.setSubject(value as string);
          continue;
        }

        // Handle serialized binary values (LoroDoc or legacy YDoc)
        if (
          isJSONObject(value) &&
          typeof value.type === 'string' &&
          typeof value.data === 'string'
        ) {
          if (value.type === 'lorodoc' || value.type === 'ydoc') {
            hydratedValues.push([key, decodeB64(value.data)]);
            continue;
          }
        }

        hydratedValues.push([key, value]);
      }

      resource.applyHydratedValues(hydratedValues);

      resource.getLoroDoc();

      if (resource.hasClasses(server.classes.error)) {
        resource.error = AtomicError.fromResource(resource);
      }
    } catch (e) {
      e.message = 'Failed parsing JSON ' + e.message;
      resource.setError(e);
      resource.loading = false;

      throw e;
    }

    return resource;
  }
}
