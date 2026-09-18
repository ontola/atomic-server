export type SearchMatchField = 'title' | 'description' | 'document';

export interface SearchResultHint {
  field: SearchMatchField;
  label: string;
  before: string;
  match: string;
  after: string;
}

interface SearchableFields {
  title?: string | null;
  description?: string | null;
  document?: string | null;
}

interface TextMatch {
  index: number;
  length: number;
}

const MAX_SNIPPET_LENGTH = 120;
const WORD_RE = /[\p{L}\p{N}]+/gu;

export function getSearchResultHint(
  query: string,
  fields: SearchableFields,
): SearchResultHint | null {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    return null;
  }

  // The row already displays the title, so prefer the richer context that
  // explains where a match occurs inside the resource.
  const candidates: Array<{
    field: SearchMatchField;
    label: string;
    text: string | null | undefined;
  }> = [
    { field: 'document', label: 'In document', text: fields.document },
    {
      field: 'description',
      label: 'In description',
      text: fields.description,
    },
    { field: 'title', label: 'Matched title', text: fields.title },
  ];

  for (const candidate of candidates) {
    if (!candidate.text) {
      continue;
    }

    const match = findTextMatch(candidate.text, trimmedQuery);

    if (match) {
      return {
        field: candidate.field,
        label: candidate.label,
        ...excerptAroundMatch(candidate.text, match),
      };
    }
  }

  return null;
}

function findTextMatch(text: string, query: string): TextMatch | null {
  const queryTokens = tokenize(query);
  const words = [...text.matchAll(WORD_RE)];
  const normalized = normalizeWithOffsets(text);
  const lowerQuery = normalizeWithOffsets(query).text;

  // A phrase may start only at a token boundary, just like the KV index.
  // Preserve source offsets: lowercasing İ, for example, adds a code unit.
  let start = 0;

  for (const word of words) {
    while (normalized.starts[start] < word.index) {
      start++;
    }

    if (normalized.text.startsWith(lowerQuery, start)) {
      return {
        index: word.index,
        length: normalized.ends[start + lowerQuery.length - 1] - word.index,
      };
    }
  }

  // Exhaust exact/prefix candidates before considering any fuzzy match.
  for (const token of queryTokens) {
    for (const wordMatch of words) {
      const word = wordMatch[0];
      const lowerWord = normalizeWithOffsets(word);

      if (lowerWord.text.startsWith(token)) {
        return {
          index: wordMatch.index,
          length: lowerWord.ends[token.length - 1],
        };
      }
    }
  }

  for (const token of queryTokens) {
    for (const wordMatch of words) {
      if (
        Array.from(token).length >= 2 &&
        fuzzyPrefixMatches(token, normalizeWithOffsets(wordMatch[0]).text)
      ) {
        return { index: wordMatch.index, length: wordMatch[0].length };
      }
    }
  }

  return null;
}

/** Locale-independent per-code-point casing, matching Rust's tokenizer. */
function normalizeWithOffsets(value: string) {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;

  for (const character of value) {
    const lower = character.toLowerCase();
    text += lower;

    for (let i = 0; i < lower.length; i++) {
      starts.push(offset);
      ends.push(offset + character.length);
    }

    offset += character.length;
  }

  return { text, starts, ends };
}

function tokenize(value: string): string[] {
  return [...value.matchAll(WORD_RE)].map(
    match => normalizeWithOffsets(match[0]).text,
  );
}

function fuzzyPrefixMatches(query: string, word: string): boolean {
  const queryChars = Array.from(query);
  const wordChars = Array.from(word);
  const minLength = Math.max(1, queryChars.length - 1);
  const maxLength = Math.min(wordChars.length, queryChars.length + 1);

  for (let length = minLength; length <= maxLength; length++) {
    if (editDistanceAtMostOne(queryChars, wordChars.slice(0, length))) {
      return true;
    }
  }

  return false;
}

function editDistanceAtMostOne(a: string[], b: string[]): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }

  let aIndex = 0;
  let bIndex = 0;
  let edits = 0;

  while (aIndex < a.length && bIndex < b.length) {
    if (a[aIndex] === b[bIndex]) {
      aIndex++;
      bIndex++;
      continue;
    }

    edits++;

    if (edits > 1) {
      return false;
    }

    if (a.length > b.length) {
      aIndex++;
    } else if (b.length > a.length) {
      bIndex++;
    } else {
      aIndex++;
      bIndex++;
    }
  }

  return edits + Number(aIndex < a.length || bIndex < b.length) <= 1;
}

function excerptAroundMatch(
  text: string,
  match: TextMatch,
): Pick<SearchResultHint, 'before' | 'match' | 'after'> {
  match = { ...match, length: Math.min(match.length, MAX_SNIPPET_LENGTH) };
  const contextBudget = MAX_SNIPPET_LENGTH - match.length;
  const leftBudget = Math.max(0, Math.floor(contextBudget / 2));
  const rightBudget = Math.max(0, contextBudget - leftBudget);
  const rawStart = Math.max(0, match.index - leftBudget);
  const rawEnd = Math.min(
    text.length,
    match.index + match.length + rightBudget,
  );
  const start = findReadableStart(text, rawStart, match.index);
  const end = findReadableEnd(text, rawEnd, match.index + match.length);
  const before = text.slice(start, match.index);
  const matchedText = text.slice(match.index, match.index + match.length);
  const after = text.slice(match.index + match.length, end);

  return {
    before: `${start > 0 ? '…' : ''}${before}`,
    match: matchedText,
    after: `${after}${end < text.length ? '…' : ''}`,
  };
}

function findReadableStart(
  text: string,
  start: number,
  matchStart: number,
): number {
  if (start === 0) {
    return 0;
  }

  const nextSpace = text.indexOf(' ', start);

  return nextSpace >= 0 && nextSpace < matchStart ? nextSpace + 1 : start;
}

function findReadableEnd(text: string, end: number, matchEnd: number): number {
  if (end === text.length) {
    return end;
  }

  const previousSpace = text.lastIndexOf(' ', end);

  return previousSpace > matchEnd ? previousSpace : end;
}
