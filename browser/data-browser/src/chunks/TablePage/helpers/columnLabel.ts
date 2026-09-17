/**
 * How a column's property is named in the table's UI — heading, filter menu,
 * property toggle, summary bar.
 *
 * A property's title falls back to its shortname when nobody gave the property
 * a name, and a shortname is an identifier rather than a label: lowercase only,
 * words joined by dashes. Rendered raw next to authored names it reads as a
 * different kind of thing — the core `name` property, which every table's first
 * column points at, has no name of its own, so that column said `name` while
 * everything beside it said `Species` or `Last watered`.
 *
 * So an identifier standing in for a label is presented as one. An authored
 * name is shown exactly as it was written: capitalising someone's `iPhone` is
 * not this function's business.
 */
export function columnLabel(
  title: string | undefined,
  shortname: string,
): string {
  if (title && title !== shortname) return title;

  const words = shortname.replace(/-/g, ' ').trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
