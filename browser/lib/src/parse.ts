import { AtomicError } from './error.js';
import { Client, isArray } from './index.js';
import { server } from './ontologies/server.js';
import { Resource, unknownSubject } from './resource.js';
import type { JSONObject, JSONValue, NamedJSONObject } from './value.js';

/**
 * Parses a JSON-AD object or array into resources. Create a new instance each time you need to parse a json-ad string.
 */
export class JSONADParser {
  private parsedResources: Resource[] = [];

  /**
   * Parses an JSON-AD object containing a resource. Returns the resource and a list of all the sub-resources it found.
   */
  public parseObject(
    jsonObject: JSONObject,
    resourceSubject?: string,
  ): [parsedRootResource: Resource, allParsedResources: Resource[]] {
    this.parsedResources = [];
    const parsedResource = this.parseJsonADResource(
      jsonObject,
      resourceSubject,
    );

    return [parsedResource, [...this.parsedResources]];
  }

  /**
   * Parses an array of JSON-AD objects containing resources.
   * Returns a list of the resources in the array and a list of all the resources that were found including sub-resources.
   */
  public parseArray(
    jsonArray: unknown[],
  ): [resourcesInArray: Resource[], allParsedResources: Resource[]] {
    this.parsedResources = [];
    const resources = this.parseJsonADArray(jsonArray);

    return [resources, [...this.parsedResources]];
  }

  public parseValue(
    value: JSONValue,
  ): [value: JSONValue, allParsedResources: Resource[]] {
    this.parsedResources = [];
    const result = this.parseJsonAdResourceValue(value);

    return [result, [...this.parsedResources]];
  }

  private parseJsonADResource(
    object: JSONObject,
    resourceSubject: string = unknownSubject,
  ): Resource {
    const resource = new Resource(resourceSubject);
    this.parsedResources.push(resource);

    try {
      for (const [key, value] of Object.entries(object)) {
        if (key === '@id') {
          if (!Client.isValidSubject(value)) {
            throw new Error(`@id value ${value} is not a valid subject`);
          }

          if (
            resource.subject !== 'undefined' &&
            resource.subject !== unknownSubject &&
            value !== resource.subject
          ) {
            throw new Error(
              `Resource has wrong subject in @id. Received subject was ${value}, expected ${resource.subject}.`,
            );
          }

          resource.setSubject(value as string);
          continue;
        }

        try {
          // Resource values can be either strings (URLs) or full Resources, which in turn can be either Anonymous (no @id) or Named (with an @id)
          if (Array.isArray(value)) {
            const [namedResources, array] = pickNamedResourcesFromArray(value);

            resource.setUnsafe(key, array);

            for (const namedResource of namedResources) {
              this.parseJsonAdResourceValue(namedResource);
            }
          } else if (isJSONObject(value)) {
            const val = this.parseJsonAdResourceValue(value);
            resource.setUnsafe(key, val);
          } else {
            resource.setUnsafe(key, value);
          }
        } catch (e) {
          const baseMsg = `Failed creating value ${value} for key ${key} in resource ${resource.subject}`;
          const errorMsg = `${baseMsg}. ${e.message}`;
          throw new Error(errorMsg);
        }
      }

      resource.loading = false;

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

  private parseJsonAdResourceValue(value: JSONValue): JSONValue {
    if (!isNamedResource(value)) {
      return value;
    }

    // It's a named resource that should be parsed too
    const nestedSubject = value['@id'] as string;
    this.parseJsonADResource(value);

    return nestedSubject;
  }

  /** Parses a JSON-AD array, returns array of Resources */
  private parseJsonADArray(jsonArray: unknown[]): Resource[] {
    const resources: Resource[] = [];

    try {
      for (const jsonObject of jsonArray) {
        const resource = this.parseJsonADResource(jsonObject as JSONObject);
        resources.push(resource);
      }
    } catch (e) {
      e.message = 'Failed parsing JSON ' + e.message;
      throw e;
    }

    return resources;
  }
}

const isJSONObject = (value: JSONValue): value is JSONObject =>
  typeof value === 'object' && value !== null && !isArray(value);

const pickNamedResourcesFromArray = (
  array: JSONValue[],
): [namedResources: NamedJSONObject[], rest: JSONValue[]] => {
  const named: NamedJSONObject[] = [];
  const rest: JSONValue[] = [];

  for (const item of array) {
    if (isNamedResource(item)) {
      rest.push(item['@id']);
      named.push(item);
    } else {
      rest.push(item);
    }
  }

  return [named, rest];
};

const isNamedResource = (value: JSONValue): value is NamedJSONObject =>
  isJSONObject(value) && '@id' in value && Client.isValidSubject(value['@id']);
