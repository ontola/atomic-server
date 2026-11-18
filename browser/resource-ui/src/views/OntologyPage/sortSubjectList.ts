import { type Store } from '@tomic/react';

/**
 * Longest we wait for one subject. An ontology list can hold stale subjects on
 * servers that are gone or refuse us; they must not stall the caller.
 */
export const SORT_SUBJECT_FETCH_DEADLINE_MS = 1500;

type Titled = { subject: string; title: string };

function fetchTitled(store: Store, subject: string): Promise<Titled> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out fetching ${subject}`)),
      SORT_SUBJECT_FETCH_DEADLINE_MS,
    );

    store.getResource(subject).then(
      r => {
        clearTimeout(timer);
        resolve({ subject, title: r.error ? '' : r.title });
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Sorts subjects by resource title. Subjects are fetched in parallel; ones that
 * fail, are unauthorized or miss the deadline are kept and placed after the
 * resolved ones, ordered by subject.
 */
export async function sortSubjectList(
  store: Store,
  subjectList: string[],
): Promise<string[]> {
  const results = await Promise.allSettled(
    subjectList.map(subject => fetchTitled(store, subject)),
  );

  const resolved: Titled[] = [];
  const unresolved: string[] = [];

  results.forEach((result, i) => {
    if (result.status === 'fulfilled' && result.value.title) {
      resolved.push(result.value);
    } else {
      unresolved.push(subjectList[i]);
    }
  });

  resolved.sort(
    (a, b) =>
      a.title.localeCompare(b.title) || a.subject.localeCompare(b.subject),
  );
  unresolved.sort((a, b) => a.localeCompare(b));

  return [...resolved.map(r => r.subject), ...unresolved];
}
