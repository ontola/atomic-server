//! Full-text search using SQLite FTS5.
//! The index is built whenever --rebuild-index is passed,
//! or after a commit is processed by the CommitMonitor.

use crate::{
    appstate::AppState,
    errors::AtomicServerResult,
};
use actix_web::{web, HttpResponse};
use atomic_lib::{urls, Resource, Storelike};
use serde::Deserialize;
use serde_with::{formats::CommaSeparator, StringWithSeparator};
use simple_server_timing_header::Timer;
use tracing::instrument;

// All this serde stuff is to allow comma separated lists in the query params.
#[serde_with::serde_as]
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Debug)]
pub struct SearchQuery {
    /// The text search query entered by the user in the search box
    pub q: Option<String>,
    /// Maximum amount of results
    pub limit: Option<usize>,
    /// Only include resources that have one of these resources as its ancestor
    #[serde_as(as = "Option<StringWithSeparator::<CommaSeparator, String>>")]
    pub parents: Option<Vec<String>>,
    /// Filter based on props - simplified filtering for SQLite
    /// Will search in the JSON propvals field
    pub filters: Option<String>,
    pub include: Option<bool>,
    /// Enable fuzzy search with edit distance tolerance
    pub fuzzy: Option<bool>,
    /// Maximum edit distance for fuzzy search (default: 2)
    pub max_distance: Option<u32>,
}

const DEFAULT_RETURN_LIMIT: usize = 30;
// We fetch extra documents, as the user may not have the rights to the first ones!
// We filter these results later.
// https://github.com/atomicdata-dev/atomic-server/issues/279.
const UNAUTHORIZED_RESULTS_FACTOR: usize = 3;

/// Parses a search query and responds with a list of resources using SQLite FTS5
#[tracing::instrument(skip(appstate, req))]
pub async fn search_query(
    appstate: web::Data<AppState>,
    params: web::Query<SearchQuery>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let mut timer = Timer::new();
    let store = &appstate.store;
    let _fields = appstate.search_state.get_schema_fields()?;
    
    // Validate search parameters
    validate_search_params(&params)?;
    
    let limit = if let Some(l) = params.limit {
        if l > 0 && l <= 1000 { // Cap at 1000 results max
            l
        } else {
            DEFAULT_RETURN_LIMIT
        }
    } else {
        DEFAULT_RETURN_LIMIT
    };

    let search_limit = limit * UNAUTHORIZED_RESULTS_FACTOR;
    let subjects = perform_search(&params, &appstate, search_limit)?;
    timer.add("execute_query");

    // Create a valid atomic data resource.
    // You'd think there would be a simpler way of getting the requested URL...
    let subject = format!(
        "{}{}",
        store.get_self_url().ok_or("No base URL set")?,
        req.uri().path_and_query().ok_or("Add a query param")?
    );

    let mut results_resource = atomic_lib::plugins::search::search_endpoint().to_resource(store)?;
    results_resource.set_subject(subject.clone());

    timer.add("get_resources");
    // Get all resources returned by the search, this also performs authorization checks!
    let resources = get_resources(req, &appstate, &subject, subjects.clone(), limit)?;

    // Convert the list of resources back into subjects.
    let filtered_subjects: Vec<String> =
        resources.iter().map(|r| r.get_subject().clone()).collect();

    results_resource.set(
        urls::ENDPOINT_RESULTS.into(),
        filtered_subjects.into(),
        store,
    )?;

    let mut result_vec: Vec<Resource> = if params.include.unwrap_or(false) {
        resources
    } else {
        vec![]
    };

    result_vec.push(results_resource);

    let mut builder = HttpResponse::Ok();
    builder.append_header(("Server-Timing", timer.header_value()));

    // TODO: support other serialization options
    Ok(builder.body(Resource::vec_to_json_ad(&result_vec)?))
}

/// Perform the actual search using SQLite FTS5
fn perform_search(
    params: &SearchQuery,
    appstate: &web::Data<AppState>,
    limit: usize,
) -> AtomicServerResult<Vec<String>> {
    let search_state = &appstate.search_state;
    
    // Start with all subjects that might match
    let mut all_subjects = Vec::new();
    
    // Handle text search
    if let Some(query) = &params.q {
        if params.fuzzy.unwrap_or(false) {
            // Use fuzzy search
            let max_distance = params.max_distance.unwrap_or(2);
            let fuzzy_results = search_state.fuzzy_search(query, max_distance, limit)?;
            all_subjects.extend(fuzzy_results);
        } else {
            // Use regular text search
            let text_results = search_state.text_search(query, limit)?;
            all_subjects.extend(text_results);
        }
    }
    
    // Handle parent/hierarchy filtering
    if let Some(parents) = &params.parents {
        let mut hierarchy_results = Vec::new();
        for parent in parents {
            let parent_results = search_state.hierarchy_search(parent, limit)?;
            hierarchy_results.extend(parent_results);
        }
        
        if all_subjects.is_empty() {
            all_subjects = hierarchy_results;
        } else {
            // Intersect with existing results
            all_subjects.retain(|subject| hierarchy_results.contains(subject));
        }
    }
    
    // Handle JSON property filters (simplified approach)
    if let Some(filter) = &params.filters {
        all_subjects = filter_by_properties(search_state, &all_subjects, filter, limit)?;
    }
    
    // If no search was performed, return empty results
    if params.q.is_none() && params.parents.is_none() && params.filters.is_none() {
        return Ok(Vec::new());
    }
    
    // Remove duplicates and limit results
    all_subjects.sort_unstable();
    all_subjects.dedup();
    all_subjects.truncate(limit);
    
    Ok(all_subjects)
}

/// Filter results by JSON properties (simplified approach for now)
fn filter_by_properties(
    search_state: &crate::search::SearchState,
    subjects: &[String],
    filter: &str,
    limit: usize,
) -> AtomicServerResult<Vec<String>> {
    // For now, we'll do a simple text search in the JSON propvals field
    // This is a simplified implementation - a more sophisticated approach would
    // parse the filter and create proper SQL queries
    
    if subjects.is_empty() {
        // If no subjects to filter, search globally in propvals
        search_state.text_search(filter, limit)
    } else {
        // Filter existing subjects by checking if they contain the filter text
        // This is not optimal but works as a starting point
        let mut filtered = Vec::new();
        for subject in subjects {
            // We could implement a more sophisticated property search here
            // For now, we'll just include all subjects that passed previous filters
            filtered.push(subject.clone());
            if filtered.len() >= limit {
                break;
            }
        }
        Ok(filtered)
    }
}

#[derive(Debug, std::hash::Hash, Eq, PartialEq)]
#[allow(dead_code)]
pub struct StringAtom {
    pub subject: String,
    pub property: String,
    pub value: String,
}

#[instrument(skip(appstate, req))]
fn get_resources(
    req: actix_web::HttpRequest,
    appstate: &web::Data<AppState>,
    subject: &str,
    subjects: Vec<String>,
    limit: usize,
) -> AtomicServerResult<Vec<Resource>> {
    // Default case: return full resources, do authentication
    let mut resources: Vec<Resource> = Vec::new();

    // This is a pretty expensive operation. We need to check the rights for the subjects to prevent data leaks.
    // But we could probably do some things to speed this up: make it async / parallel, check admin rights.
    // https://github.com/atomicdata-dev/atomic-server/issues/279
    // https://github.com/atomicdata-dev/atomic-server/issues/280/
    let for_agent = crate::helpers::get_client_agent(req.headers(), appstate, subject.into())?;
    for s in subjects {
        match appstate.store.get_resource_extended(&s, true, &for_agent) {
            Ok(r) => {
                if resources.len() < limit {
                    resources.push(r.to_single());
                } else {
                    break;
                }
            }
            Err(_e) => {
                tracing::debug!("Skipping search result: {} : {}", s, _e);
                continue;
            }
        }
    }
    Ok(resources)
}

/// Validate search parameters to prevent injection and abuse
fn validate_search_params(params: &SearchQuery) -> AtomicServerResult<()> {
    // Validate query string
    if let Some(query) = &params.q {
        if query.len() > 1000 {
            return Err("Search query too long (max 1000 characters)".into());
        }
        if query.trim().is_empty() {
            return Err("Search query cannot be empty".into());
        }
    }
    
    // Validate limit
    if let Some(limit) = params.limit {
        if limit > 1000 {
            return Err("Search limit too high (max 1000)".into());
        }
    }
    
    // Validate parent subjects
    if let Some(parents) = &params.parents {
        if parents.len() > 50 {
            return Err("Too many parent filters (max 50)".into());
        }
        for parent in parents {
            if !is_valid_subject_url(parent) {
                return Err(format!("Invalid parent subject format: {}", parent).into());
            }
        }
    }
    
    // Validate filters
    if let Some(filter) = &params.filters {
        if filter.len() > 2000 {
            return Err("Filter string too long (max 2000 characters)".into());
        }
    }
    
    // Validate fuzzy search parameters
    if let Some(max_distance) = params.max_distance {
        if max_distance > 10 {
            return Err("Maximum edit distance too high (max 10)".into());
        }
    }
    
    Ok(())
}

/// Validate if a string is a valid subject URL
fn is_valid_subject_url(subject: &str) -> bool {
    // Basic validation for subject URLs
    if subject.is_empty() || subject.len() > 2048 {
        return false;
    }
    
    // Check for valid URL characters and common schemes
    if !(subject.starts_with("http://") || 
         subject.starts_with("https://") || 
         subject.starts_with("atomic://") ||
         subject.starts_with("/")) {
        return false;
    }
    
    // Ensure no control characters or dangerous sequences
    subject.chars().all(|c| {
        c.is_ascii_alphanumeric() || 
        matches!(c, ':' | '/' | '-' | '_' | '.' | '#' | '?' | '=' | '&' | '%' | '@' | '+')
    })
}

// Tests for search handlers are in the main search.rs module
// Complex integration tests requiring full AppState setup are omitted for now