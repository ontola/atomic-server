/** Connection parameters some platforms can list for the user instead of
 * requiring a raw id typed by hand — e.g. Moneybird's `administration_id`,
 * which scopes every request but is otherwise only visible by name in its
 * own UI. */
export interface ParameterOptionLookup {
  path: string;
  itemValue: string;
  itemLabel: string;
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

export interface ParameterOption {
  value: string;
  label: string;
}

/** Parses a proxied list response into dropdown options, skipping entries
 * without a usable id rather than failing the whole lookup. */
export function parseParameterOptions(
  body: string,
  lookup: ParameterOptionLookup,
): ParameterOption[] {
  const items: unknown = JSON.parse(body);
  if (!Array.isArray(items)) return [];

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
