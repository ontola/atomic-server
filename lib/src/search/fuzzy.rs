//! 1-edit neighborhood generation and prefix-aware Levenshtein.

use std::collections::HashSet;

/// Unicode Levenshtein distance, capped: returns `max+1` as soon as the
/// remaining distance cannot be ≤ `max`. Fine for the 1-edit verify path.
pub fn levenshtein_at_most(a: &[char], b: &[char], max: usize) -> usize {
    let n = a.len();
    let m = b.len();
    if n.abs_diff(m) > max {
        return max + 1;
    }
    if n == 0 {
        return m;
    }
    if m == 0 {
        return n;
    }
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut curr = vec![0usize; m + 1];
    for i in 1..=n {
        curr[0] = i;
        let mut row_min = curr[0];
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            curr[j] = (prev[j] + 1).min(curr[j - 1] + 1).min(prev[j - 1] + cost);
            row_min = row_min.min(curr[j]);
        }
        if row_min > max {
            return max + 1;
        }
        std::mem::swap(&mut prev, &mut curr);
    }
    prev[m]
}

/// `min_P prefix of term: levenshtein(query, P)`.
///
/// Tantivy's `FuzzyTermQuery::new_prefix(term, 1, true)` matches when some
/// prefix of the indexed term is within edit distance 1 of the query.
pub fn min_prefix_levenshtein(query: &str, term: &str) -> usize {
    if term.starts_with(query) || query == term {
        return 0;
    }
    let q: Vec<char> = query.chars().collect();
    let t: Vec<char> = term.chars().collect();
    if q.is_empty() {
        return 0;
    }
    let qn = q.len();
    let start = qn.saturating_sub(1).max(1);
    let end = (qn + 1).min(t.len());
    let mut best = usize::MAX;
    for len in start..=end {
        let d = levenshtein_at_most(&q, &t[..len], 1);
        if d < best {
            best = d;
        }
        if best == 0 {
            return 0;
        }
    }
    // Also compare against the full term when it is longer — a 1-edit of the
    // whole word (avocado / avacado) is the common typo case.
    if t.len() != qn {
        best = best.min(levenshtein_at_most(&q, &t, 1));
    }
    best
}

/// All strings at Damerau-Levenshtein distance 1 from `q`.
///
/// Alphabet is `[a-z0-9]` plus any extra characters already in `q`, so a
/// non-ASCII query still generates substitutions of its own letters.
pub fn one_edits(q: &str) -> HashSet<String> {
    let chars: Vec<char> = q.chars().collect();
    let mut alphabet: Vec<char> = ('a'..='z').chain('0'..='9').collect();
    for c in &chars {
        if !alphabet.contains(c) {
            alphabet.push(*c);
        }
    }
    let mut out = HashSet::new();
    let n = chars.len();

    for i in 0..n {
        let mut s = chars.clone();
        s.remove(i);
        out.insert(s.into_iter().collect());
    }
    for i in 0..n {
        for &a in &alphabet {
            if a == chars[i] {
                continue;
            }
            let mut s = chars.clone();
            s[i] = a;
            out.insert(s.into_iter().collect());
        }
    }
    for i in 0..=n {
        for &a in &alphabet {
            let mut s = chars.clone();
            s.insert(i, a);
            out.insert(s.into_iter().collect());
        }
    }
    for i in 0..n.saturating_sub(1) {
        if chars[i] == chars[i + 1] {
            continue;
        }
        let mut s = chars.clone();
        s.swap(i, i + 1);
        out.insert(s.into_iter().collect());
    }
    out.remove(q);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn avocado_typo_is_distance_one() {
        assert_eq!(min_prefix_levenshtein("avacado", "avocado"), 1);
        assert_eq!(min_prefix_levenshtein("avocado", "avocado"), 0);
    }

    #[test]
    fn typeahead_prefix_is_distance_zero() {
        assert_eq!(min_prefix_levenshtein("avo", "avocado"), 0);
    }

    #[test]
    fn one_edit_prefix_of_longer_term() {
        // "avp" → prefix "avo" of "avocado"
        assert_eq!(min_prefix_levenshtein("avp", "avocado"), 1);
    }

    #[test]
    fn one_edits_contains_the_typo_fix() {
        let edits = one_edits("avacado");
        assert!(edits.contains("avocado"), "missing avocado in {edits:?}");
    }
}
