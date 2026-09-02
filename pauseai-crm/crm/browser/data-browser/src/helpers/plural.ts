/**
 * A function that returns the correct text for a given number. This function is detected by Wuchale so the translations will be pluralized correctly.
 * Use a # in the text as a placeholder for the number.
 * @param num - The number displayed in the text.
 * @param candidates - The options for the text, by default the first is the singular and the second is the plural.
 */
export function plural(
  num: number,
  candidates: string[],
  rule = (n: number) => (n === 1 ? 0 : 1),
) {
  const index = rule(num);

  return candidates[index].replace('#', `${num}`);
}
