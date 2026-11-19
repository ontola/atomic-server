// @wc-ignore-file
// Schema titles and field names are source data, not application copy.
type Schema = Record<string, unknown>;

export interface JSONCellPreview {
  text: string;
  readable: boolean;
  truncated: boolean;
}

const MAX_DEPTH = 12;
const MAX_NODES = 200;
const MAX_LENGTH = 4000;
const unsupported = Symbol('unsupported schema');

function isObject(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Stop after two own keys; a truncated render does not identify a wrapper. */
function singleOwnKey(value: Schema): string | undefined {
  let found: string | undefined;

  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    if (found !== undefined) return undefined;
    found = key;
  }

  return found;
}

/** A deliberately small display vocabulary. Unsupported shapes keep their JSON. */
export function schemaJSONPreview(
  value: unknown,
  schema: unknown,
): JSONCellPreview {
  function preview(readable: boolean): JSONCellPreview {
    let nodes = 0;
    let length = 0;
    let truncated = false;

    function text(input: string): string {
      const remaining = Math.max(0, MAX_LENGTH - length);
      length += input.length;

      if (input.length <= remaining) return input;

      truncated = true;

      return `${input.slice(0, remaining)}…`;
    }

    function resolve(input: unknown): Schema {
      if (!isObject(input)) throw unsupported;

      const seen = new Set<unknown>();
      let definition: Schema = input;

      while (typeof definition.$ref === 'string') {
        if (seen.has(definition) || seen.size >= MAX_DEPTH) throw unsupported;
        seen.add(definition);

        const reference = definition.$ref;
        if (reference !== '#' && !reference.startsWith('#/')) throw unsupported;

        const parts = reference === '#' ? [] : reference.slice(2).split('/');
        if (parts.length > MAX_DEPTH) throw unsupported;
        let target: unknown = schema;

        for (const part of parts) {
          const key = part.replace(/~1/g, '/').replace(/~0/g, '~');

          if (!isObject(target) || !Object.hasOwn(target, key))
            throw unsupported;
          target = target[key];
        }

        if (!isObject(target)) throw unsupported;
        definition = target;
      }

      if (
        definition.oneOf ||
        definition.anyOf ||
        definition.allOf ||
        definition.not
      ) {
        throw unsupported;
      }

      return definition;
    }

    function render(current: unknown, input: unknown, depth: number): string {
      nodes++;

      if (depth > MAX_DEPTH || nodes > MAX_NODES || length >= MAX_LENGTH) {
        truncated = true;

        return '…';
      }

      const definition = readable ? resolve(input) : undefined;
      const type = definition?.type;
      const types = Array.isArray(type) ? type : [type];
      const currentType =
        current === null
          ? 'null'
          : Array.isArray(current)
            ? 'array'
            : typeof current;

      if (
        readable &&
        !types.includes(currentType) &&
        !(
          currentType === 'number' &&
          Number.isInteger(current) &&
          types.includes('integer')
        ) &&
        !(current === null && definition?.nullable === true)
      ) {
        throw unsupported;
      }

      if (current === null) return text('null');

      if (typeof current === 'string') {
        const bounded = current.slice(0, MAX_LENGTH);
        if (bounded.length < current.length) truncated = true;

        return text(readable ? bounded : JSON.stringify(bounded));
      }

      if (typeof current === 'boolean') {
        return text(readable ? (current ? '☑' : '☐') : String(current));
      }

      if (typeof current === 'number') return text(String(current));

      if (current === undefined) return '';

      if (Array.isArray(current)) {
        if (readable && !isObject(definition?.items)) throw unsupported;

        const items: string[] = [];

        for (const item of current) {
          const rendered = render(item, definition?.items, depth + 1);
          items.push(
            readable ? `• ${rendered.replace(/\n/g, '\n  ')}` : rendered,
          );
          if (truncated) break;
        }

        return readable ? items.join('\n') || '[]' : `[${items.join(',')}]`;
      }

      if (!isObject(current)) throw unsupported;

      const properties = definition?.properties;
      if (readable && !isObject(properties)) throw unsupported;

      // Wrappers may have several optional schema fields but only one value.
      // Collapse them before rendering so truncation neither invents labels nor
      // mistakes the first rendered field of a larger object for a wrapper.
      const singleKey = readable ? singleOwnKey(current) : undefined;

      if (singleKey !== undefined && typeof current[singleKey] !== 'boolean') {
        const field =
          isObject(properties) && Object.hasOwn(properties, singleKey)
            ? properties[singleKey]
            : undefined;

        return render(current[singleKey], field, depth + 1);
      }

      const fields: string[] = [];

      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        const field =
          isObject(properties) && Object.hasOwn(properties, key)
            ? properties[key]
            : undefined;
        // Reserve the label before the child can consume the text budget.
        // Boolean fields retain their labels rather than acquiring semantics.
        const label = readable
          ? text(
              isObject(field) && typeof field.title === 'string'
                ? field.title
                : key,
            )
          : text(JSON.stringify(key));
        const rendered = render(current[key], field, depth + 1);
        fields.push(`${label}: ${rendered}`);
        if (truncated) break;
      }

      return readable ? fields.join('\n') || '{}' : `{${fields.join(',')}}`;
    }

    const rendered = render(value, schema, 0);
    if (rendered.length > MAX_LENGTH) truncated = true;

    return {
      text: truncated ? `${rendered.slice(0, MAX_LENGTH - 1)}…` : rendered,
      readable,
      truncated,
    };
  }

  try {
    return preview(true);
  } catch (error) {
    if (error !== unsupported) throw error;

    return preview(false);
  }
}
