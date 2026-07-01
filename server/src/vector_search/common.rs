use atomic_lib::Resource;

pub fn get_resource_title(resource: &Resource) -> Option<String> {
    let title = if let Ok(name) = resource.get(atomic_lib::urls::NAME) {
        name.clone()
    } else if let Ok(shortname) = resource.get(atomic_lib::urls::SHORTNAME) {
        shortname.clone()
    } else if let Ok(filename) = resource.get(atomic_lib::urls::FILENAME) {
        filename.clone()
    } else {
        // We don't return the subject as a default because we don't want to index it.
        return None;
    };

    match title {
        atomic_lib::Value::String(s) => Some(s),
        atomic_lib::Value::Slug(s) => Some(s),
        _ => None,
    }
}

pub fn get_resource_text_parts(
    resource: &Resource,
) -> (Option<String>, Option<String>, Option<String>) {
    let title = get_resource_title(resource);

    let description = match resource.get(atomic_lib::urls::DESCRIPTION) {
        Ok(atomic_lib::Value::Markdown(s)) => Some(s.to_string()),
        _ => None,
    };

    let doc_content = resource.materialized_state().and_then(|snapshot| {
        atomic_lib::loro::AtomicLoroDoc::from_snapshot(&snapshot)
            .ok()
            .map(|loro_doc| loro_doc.extract_document_plain_text())
            .filter(|text| !text.is_empty())
    });

    (title, description, doc_content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::{urls, Resource, Value};

    #[test]
    fn get_resource_title_prefers_name() {
        let mut resource = Resource::new("https://example.com/doc".into());
        resource
            .set_unsafe(urls::NAME.into(), Value::String("My Doc".into()))
            .unwrap();
        resource
            .set_unsafe(urls::SHORTNAME.into(), Value::Slug("short".into()))
            .unwrap();
        assert_eq!(get_resource_title(&resource).as_deref(), Some("My Doc"));
    }

    #[test]
    fn get_resource_text_parts_reads_markdown_description() {
        let mut resource = Resource::new("https://example.com/part".into());
        resource
            .set_unsafe(urls::NAME.into(), Value::String("Reasoning".into()))
            .unwrap();
        resource
            .set_unsafe(
                urls::DESCRIPTION.into(),
                Value::Markdown("Some **markdown**".into()),
            )
            .unwrap();

        let (title, description, doc) = get_resource_text_parts(&resource);
        assert_eq!(title.as_deref(), Some("Reasoning"));
        assert_eq!(description.as_deref(), Some("Some **markdown**"));
        assert!(doc.is_none());
    }

    #[test]
    fn get_resource_text_parts_reads_description_after_loro_materialize() {
        let doc = atomic_lib::loro::AtomicLoroDoc::new();
        doc.set_property(urls::NAME, &Value::String("leave-of-absence.md".into()))
            .unwrap();
        doc.set_property(
            urls::DESCRIPTION,
            &Value::Markdown("# Leave of absence\n\nEmployees may take lunch breaks.".into()),
        )
        .unwrap();

        let mut resource = Resource::new("https://example.com/handbook".into());
        resource.apply_state_doc(doc).unwrap();

        let (title, description, doc_content) = get_resource_text_parts(&resource);
        assert_eq!(title.as_deref(), Some("leave-of-absence.md"));
        assert!(description.unwrap().contains("lunch breaks"));
        assert!(doc_content.is_none());
    }
}
