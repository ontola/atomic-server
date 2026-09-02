use atomic_lib::endpoints::Endpoint;

pub fn export_endpoint() -> Endpoint {
    Endpoint::builder("/export")
        .params(["subject", "format", "display_refs_as_name"])
        .description(
            r#"Export table data

Use with the following parameters
- **subject**: Subject of the resource to export.
- **format**: Format of the export, currently only supports `csv`.
- **display_refs_as_name**: If true, it will display referenced resources by their name instead of subject.
"#,
        )
        .build()
}
