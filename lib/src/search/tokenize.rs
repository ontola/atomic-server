//! Lowercase alphanumeric tokenizer. No stemming.

pub fn tokenize(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c.is_alphanumeric() {
            current.extend(c.to_lowercase());
        } else if !current.is_empty() {
            tokens.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_on_punctuation_and_lowercases() {
        assert_eq!(
            tokenize("Avocado Toast! (ripe)"),
            vec!["avocado", "toast", "ripe"]
        );
    }

    #[test]
    fn keeps_numbers() {
        assert_eq!(tokenize("note-42"), vec!["note", "42"]);
    }
}
