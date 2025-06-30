import { AtomicError } from './error.js';
import { Client } from './index.js';
import { server } from './ontologies/server.js';
import { Resource, unknownSubject } from './resource.js';
import {
  type JSONObject,
  type JSONValue,
  isJSONObject,
} from './value.js';
import { decodeB64 } from './base64.js';

/**
 * Parses a JSON-AD object or array into resources. Create a new instance each time you need to parse a json-ad string.
 */
export class JSONADParser {
  public parse(json: unknown, subject: string = unknownSubject): Resource[] {
    if (Array.isArray(json)) {
      return json.flatMap(item => this.parse(item, subject));
    }

    if (typeof json !== 'object' || json === null) {
      throw new Error('JSON-AD must be an object or array');
    }

    return [this.parseObject(json as JSONObject, subject)];
  }

  private parseObject(json: JSONObject, subject: string): Resource {
    const resource = new Resource(subject);

    try {
      for (const [key, value] of Object.entries(json)) {
        if (key === '@id') {
          if (typeof value !== 'string') {
            throw new Error('Expected @id to be a string');
          }

          if (subject !== unknownSubject && value !== subject) {
            // Subjects might differ between the request URL (which could
            // include query params) and the canonical subject returned by
            // the server. Only throw when the pure path/id parts conflict.
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
        if (isJSONObject(value) && typeof value.type === 'string' && typeof value.data === 'string') {
          if (value.type === 'lorodoc' || value.type === 'ydoc') {
            // Store as raw binary Uint8Array
            resource.setUnsafe(key, decodeB64(value.data));
            continue;
          }
        }

        resource.setUnsafe(key, value);
      }

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
