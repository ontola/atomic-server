/**
 * Step timings on the browser's User Timing timeline, so a flow's phases show
 * up in the Performance panel and in `performance.getEntriesByType('measure')`.
 * Each `step` measures from the previous step (or the start) to now. Cheap and
 * silent where the API is missing.
 */
export function userTiming(name: string) {
  const now = () =>
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  let last = now();

  return {
    step(label: string) {
      const end = now();

      try {
        performance.measure(`${name}:${label}`, { start: last, end });
      } catch {
        // No User Timing here (very old browser or a test runtime).
      }

      last = end;
    },
  };
}
