import { AtomicError } from './error.js';
import { Client } from './index.js';
import { server } from './ontologies/server.js';
import { Resource, unknownSubject } from './resource.js';
import {
  type JSONObject,
  type JSONValue,
  isJSONObject,
  isSerializedYUpdate,
  type SerializedYUpdate,
} from './value.js';
import { decodeB64 } from './base64.js';
import { YLoader } from './yjs.js';
import type * as Y from 'yjs';

/**
 * Parses a JSON-AD object or array into resources. Create a new instance each time you need to parse a json-ad string.
 */
export class JSONADParser {
  public parse(json: unknown, subject: string = unknownSubject): Resource[] {
    if (Array.isArray(json)) {
      return this.parseArray(json);
    }

    if (isJSONObject(json as JSONValue)) {
      return [this.parseObject(json as JSONObject, subject)];
    }

    throw new Error(`Expected object or array, got ${typeof json}`);
  }

  /**
   * Parses an JSON-AD object containing a resource. Returns the resource and a list of all the sub-resources it found.
   */
  private parseObject(
    jsonObject: JSONObject,
    resourceSubject?: string,
  ): Resource {
    const parsedResource = this.parseJsonADResource(
      jsonObject,
      resourceSubject,
    );

    return parsedResource;
  }

  /**
   * Parses an array of JSON-AD objects containing resources.
   * Returns a list of the resources in the array and a list of all the resources that were found including sub-resources.
   */
  private parseArray(jsonArray: unknown[]): Resource[] {
    const resources: Resource[] = [];

    for (const item of jsonArray as JSONValue[]) {
      if (!isJSONObject(item)) {
        throw new Error(
          `Error parsing JSON-AD Array, expected object, got ${typeof item}`,
        );
      }

      const resource = this.parseJsonADResource(item);
      resources.push(resource);
    }

    return resources;
  }

  private parseJsonADResource(
    object: JSONObject,
    resourceSubject: string = unknownSubject,
  ): Resource {
    const resource = new Resource(resourceSubject);
    resource.loading = false;

    try {
      for (const [key, value] of Object.entries(object)) {
        if (key === '@id') {
          if (!Client.isValidSubject(value)) {
            throw new Error(`@id value ${value} is not a valid subject`);
          }

          if (
            resource.subject !== 'undefined' &&
            resource.subject !== unknownSubject &&
            value !== resource.subject &&
            value !== resource.subject + '/' &&
            value + '/' !== resource.subject
          ) {
            // If the requested subject is an HTTP URL or relative path, and the received subject is a DID, we allow it (Alias support).
            const isDID = (s: string) => s.startsWith('did:');
            const isAliasCandidate = (s: string) =>
              s.startsWith('http') ||
              s.startsWith('/') ||
              !s.includes(':') ||
              s === '';

            if (isAliasCandidate(resource.subject) && isDID(value as string)) {
              // eslint-disable-next-line no-console
              console.log(
                `Alias detected: Requested ${resource.subject}, received ${value}. Allowing mismatch.`,
              );
            } else {
              throw new Error(
                `Resource has wrong subject in @id. Received subject was ${value}, expected ${resource.subject}.`,
              );
            }
          }

          resource.setSubject(value as string);
          continue;
        }

        if (isSerializedYUpdate(value)) {
          const doc = this.parseYDoc(value);
          resource.setUnsafe(key, doc);
          continue;
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

  private parseYDoc(value: SerializedYUpdate): Y.Doc | SerializedYUpdate {
    if (!YLoader.isLoaded()) {
      return value;
    }

    const Y = YLoader.Y;

    const doc = new Y.Doc();
    Y.applyUpdateV2(doc, decodeB64(value.data));

    return doc;
  }
}
