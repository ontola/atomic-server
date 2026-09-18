/**
 * How a column's property is named in the table's UI — heading, filter menu,
 * filter chip, property toggle, summary bar, Kanban card field.
 *
 * Most properties carry a name someone wrote, and that name is shown exactly as
 * written: `iPhone model` and `well-being` are nobody else's to tidy up. A
 * property with no name at all is a different case — all that is left to label
 * it with is its shortname, and a shortname is an identifier rather than a
 * label: lowercase only, words joined by dashes. Rendered raw beside authored
 * names it reads as a different kind of thing, which is why the first column of
 * every table said `name` next to `Species` and `Last watered`: the core `name`
 * property has no name of its own.
 *
 * So an identifier standing in for a label is presented as one, and nothing
 * else is touched. Note this takes the property's own `name` value, not the
 * title from `useTitle`/`Resource.title` — those already fall back to the
 * shortname, which would make the two cases indistinguishable here.
 */
export function columnLabel(
  name: string | undefined,
  shortname: string,
): string {
  if (name) return name;

  const words = shortname.replace(/-/g, ' ').trim();

  return words.charAt(0).toUpperCase() + words.slice(1);
}
