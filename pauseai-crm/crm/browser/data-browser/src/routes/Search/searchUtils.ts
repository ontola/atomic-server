type FilterObject = Record<string, string | number | string[]>;

export function filterToBase64String(filter: FilterObject): string {
  return btoa(JSON.stringify(filter));
}

export function base64StringToFilter(base64String: string): FilterObject {
  return JSON.parse(atob(base64String));
}
