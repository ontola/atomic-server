/** Connection parameters some platforms can list for the user instead of
 * requiring a raw id typed by hand — e.g. Moneybird's `administration_id`,
 * which scopes every request but is otherwise only visible by name in its
 * own UI. */
export interface ParameterOptionLookup {
  path: string;
  itemValue: string;
  itemLabel: string;
  /** What to call the parameter in the form; the raw key when omitted. */
  label?: string;
}

export const PARAMETER_OPTION_LOOKUPS: Record<
  string,
  Record<string, ParameterOptionLookup>
> = {
  moneybird: {
    administration_id: {
      path: '/api/v2/administrations.json',
      itemValue: 'id',
      itemLabel: 'name',
    },
  },
};

export function parameterLabel(platform: string, parameter: string): string {
  return PARAMETER_OPTION_LOOKUPS[platform]?.[parameter]?.label ?? parameter;
}

export interface ParameterOption {
  value: string;
  label: string;
}

/** Parses a proxied list response into dropdown options, skipping entries
 * without a usable id rather than failing the whole lookup. A single object
 * (an endpoint like `/v1/user`) is a one-item list. */
export function parseParameterOptions(
  body: string,
  lookup: ParameterOptionLookup,
): ParameterOption[] {
  const parsed: unknown = JSON.parse(body);
  const items = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? [parsed]
      : [];

  const options: ParameterOption[] = [];

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const value = record[lookup.itemValue];
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const label = record[lookup.itemLabel];
    options.push({
      value: String(value),
      label:
        typeof label === 'string' || typeof label === 'number'
          ? String(label)
          : String(value),
    });
  }

  return options;
}
