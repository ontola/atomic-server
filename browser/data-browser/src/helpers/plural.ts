/**
 * A function that returns the correct text for a given number. This function is detected by Wuchale so the translations will be pluralized correctly.
 * Use a # in the text as a placeholder for the number.
 * @param num - The number displayed in the text.
 * @param candidates - The options for the text, by default the first is the singular and the second is the plural.
 */
export function plural(
  num: number,
  candidates: string[],
  rule: (n: number) => number = n => (n === 1 ? 0 : 1),
) {
  // Wuchale compiles the Plural-Forms header of a catalog verbatim, and gettext
  // rules such as nl's `(n != 1)` return a boolean, which is no array index.
  // A catalog can also hold fewer forms than the rule picks (id has one), or
  // none while it has not loaded. Use the last form rather than crash.
  const index = Number(rule(num));

  return (candidates[index] ?? candidates.at(-1) ?? '').replace('#', `${num}`);
}
