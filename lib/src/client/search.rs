/*!
# Search Client

Use the `/search` endpoint from AtomicServer to perform full-text search.
*/

use std::collections::HashMap;
use url::Url;

use crate::agents::Agent;

// Define the SearchOpts struct with optional fields
#[derive(Debug, Default)]
pub struct SearchOpts {
    pub include: Option<bool>,
    pub limit: Option<u32>,
    pub parents: Option<Vec<String>>,
    pub filters: Option<HashMap<String, String>>,
    /// The agent to use for authentication
    pub agent: Option<Agent>,
}

// Function to build the base URL for search
fn base_url(server_url: &str) -> Url {
    if server_url.starts_with("internal:") {
        let mut url = Url::parse(server_url).expect("Invalid internal search URL");
        url.set_path("search");
        return url;
    }
    let mut url = Url::parse(server_url).expect("Invalid server URL");
    url.set_path("search");
    url
}

// Special characters for Tantivy query escaping
const SPECIAL_CHARS_TANTIVY: &[char] = &[
    '+', '^', '`', ':', '{', '}', '"', '[', ']', '(', ')', '!', '\\', '*', ' ', '.',
];

// Escape function for Tantivy syntax
fn escape_tantivy_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if SPECIAL_CHARS_TANTIVY.contains(&c) {
                format!("\\{}", c)
            } else {
                c.to_string()
            }
        })
        .collect()
}

// Build the filter string for the URL
fn build_filter_string(filters: &HashMap<String, String>) -> String {
    filters
        .iter()
        .filter_map(|(key, value)| {
            if !value.is_empty() {
                Some(format!("{}:\"{}\"", escape_tantivy_key(key), value))
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}

// Build the complete search URL with query parameters
pub fn build_search_subject(server_url: &str, query: &str, opts: SearchOpts) -> String {
    let mut url = base_url(server_url);

    url.query_pairs_mut().append_pair("q", query);
    if let Some(include) = opts.include {
        url.query_pairs_mut()
            .append_pair("include", &include.to_string());
    }
    if let Some(limit) = opts.limit {
        url.query_pairs_mut()
            .append_pair("limit", &limit.to_string());
    }
    if let Some(filters) = opts.filters {
        if !filters.is_empty() {
            let filter_string = build_filter_string(&filters);
            url.query_pairs_mut().append_pair("filters", &filter_string);
        }
    }
    if let Some(parents) = opts.parents {
        let parents_string = parents.join(",");
        url.query_pairs_mut()
            .append_pair("parents", &parents_string);
    }

    url.to_string()
}
#[cfg(test)]
mod tests {
    use super::*;

    fn search_query_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../testdata/search-query.json"))
            .expect("testdata/search-query.json")
    }

    #[test]
    fn test_base_url() {
        let server_url = "http://example.com";
        let expected_url = "http://example.com/search";
        assert_eq!(base_url(server_url).to_string(), expected_url);
    }

    #[test]
    fn test_escape_tantivy_key() {
        for case in search_query_fixture()["escape"]
            .as_array()
            .expect("escape array")
        {
            let input = case["input"].as_str().unwrap();
            let escaped = case["escaped"].as_str().unwrap();
            assert_eq!(
                escape_tantivy_key(input),
                escaped,
                "escape mismatch for {input:?}"
            );
        }
    }

    #[test]
    fn test_build_filter_string() {
        let mut filters = HashMap::new();
        filters.insert("name".to_string(), "John".to_string());
        filters.insert("age".to_string(), "30".to_string());
        let expected_filter_string = "name:\"John\" AND age:\"30\"";
        let expected_filter_string_alt = "age:\"30\" AND name:\"John\"";
        let result = build_filter_string(&filters);
        assert!(result == expected_filter_string || result == expected_filter_string_alt);
    }

    #[test]
    fn test_build_search_subject() {
        let subject = &search_query_fixture()["searchSubject"];
        let mut filters = HashMap::new();
        for (key, value) in subject["filters"].as_object().unwrap() {
            filters.insert(key.clone(), value.as_str().unwrap().to_string());
        }
        let opts = SearchOpts {
            include: Some(subject["include"].as_bool().unwrap()),
            limit: Some(subject["limit"].as_u64().unwrap() as u32),
            filters: Some(filters),
            parents: Some(vec![subject["parents"].as_str().unwrap().to_string()]),
            agent: None,
        };
        assert_eq!(
            build_search_subject(
                subject["serverUrl"].as_str().unwrap(),
                subject["query"].as_str().unwrap(),
                opts
            ),
            subject["expected"].as_str().unwrap()
        );
    }
}
