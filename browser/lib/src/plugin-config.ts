import type { DeclaredConfig } from './plugin-manifest.js';
import type { Problem } from './plugin-run.js';
import type { JSONObject, JSONValue } from './value.js';

/**
 * Where a plugin's user-editable config comes from, and what it means for it
 * to be missing.
 *
 * `run()` reads its config from `input.config`, so every caller that runs a
 * plugin — preview, a manual run, a scheduled one — has to assemble that field
 * the same way. When one of them skips it, the plugin destructures `undefined`
 * and the run dies with a `TypeError` naming an internal field, which is no
 * help to the person who only ever saw an import that would not start.
 *
 * So the host builds the config in one place ({@link pluginConfigFor}) and
 * checks it against what the plugin declared ({@link pluginConfigProblems})
 * before calling `run()`. A misconfigured import then pauses on a problem that
 * names the field to set, which is the failure the UI was built to show.
 */

function asObject(value: unknown): JSONObject | undefined {
  const decoded =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return undefined;
          }
        })()
      : value;

  return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
    ? (decoded as JSONObject)
    : undefined;
}

/** The installation properties config can be stored in, as read from the resource. */
export interface StoredPluginConfig {
  /** `plugin-schemas`: what the install wizards write, keyed or flat. */
  schemas?: unknown;
  /** `plugin-connection`: a connected provider carries its config in there. */
  connection?: unknown;
}

/**
 * The `config` to hand `run()`, from whatever the installation stored.
 *
 * Never undefined: a plugin that has no config stored is given `{}` and fails
 * — if it fails at all — on a field it can name, rather than on the absence of
 * the object holding the fields.
 */
export function pluginConfigFor(
  stored: StoredPluginConfig,
  declared?: DeclaredConfig,
): JSONObject {
  const schemas = asObject(stored.schemas) ?? {};
  // A plugin sharing the property with schema terms says which key is its own;
  // one that owns the property stores its fields flat.
  const fromSchemas = declared?.key ? asObject(schemas[declared.key]) : schemas;

  if (fromSchemas && Object.keys(fromSchemas).length > 0) return fromSchemas;

  return asObject(asObject(stored.connection)?.config) ?? fromSchemas ?? {};
}

function isEmpty(value: JSONValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim().length === 0;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value).length === 0;

  return false;
}

/**
 * What is wrong with this config, in the words of the plugin that declared it.
 *
 * A plugin that declares nothing gets no checking: the contract stays optional,
 * and an undeclared config is still passed through as before.
 */
export function pluginConfigProblems(
  config: JSONObject,
  declared?: DeclaredConfig,
): Problem[] {
  if (!declared) return [];

  const problems: Problem[] = [];
  const required = new Set(declared.required ?? []);

  for (const [name, field] of Object.entries(declared.properties ?? {})) {
    const value = config[name];

    if (isEmpty(value)) {
      if (required.has(name))
        problems.push({
          severity: 'error',
          message: `This import is missing required config field \`${name}\`${
            field.description ? ` (${field.description})` : ''
          }. Set it on the import, then preview again.`,
        });

      continue;
    }

    const matches =
      field.type === 'string'
        ? typeof value === 'string'
        : typeof value === 'object' && !Array.isArray(value);

    if (!matches)
      problems.push({
        severity: 'error',
        message: `Config field \`${name}\` must be ${
          field.type === 'string' ? 'text' : 'an object'
        }. Correct it on the import, then preview again.`,
      });
  }

  for (const name of required)
    if (!(name in (declared.properties ?? {})) && isEmpty(config[name]))
      problems.push({
        severity: 'error',
        message: `This import is missing required config field \`${name}\`. Set it on the import, then preview again.`,
      });

  return problems;
}
