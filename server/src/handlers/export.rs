use std::collections::HashMap;

use crate::{appstate::AppState, errors::AtomicServerResult, helpers::get_client_agent};
use actix_web::http::header::{ContentDisposition, DispositionParam, DispositionType};
use actix_web::{web, HttpResponse};
use atomic_lib::agents::ForAgent;
use atomic_lib::db::drive_prefix_from_subject;
use atomic_lib::errors::AtomicResult;
use atomic_lib::storelike::Query;
use atomic_lib::values::SubResource;
use atomic_lib::{urls, Db, Resource, Storelike, Value};
use chrono::DateTime;
use serde::Deserialize;

#[serde_with::serde_as]
#[serde_with::skip_serializing_none]
#[derive(Deserialize, Debug)]
pub struct ExportParams {
    pub format: Option<String>,
    pub subject: Option<String>,
    pub display_refs_as_name: Option<bool>,
}

/// Exports a resource in the specified format.
#[tracing::instrument(skip(appstate, req))]
pub async fn handle_export(
    path: Option<web::Path<String>>,
    appstate: web::Data<AppState>,
    params: web::Query<ExportParams>,
    req: actix_web::HttpRequest,
) -> AtomicServerResult<HttpResponse> {
    let headers = req.headers();
    let store = &appstate.store;

    let Some(subject) = params.subject.clone() else {
        return Err("No subject provided".into());
    };

    let Some(format) = params.format.clone() else {
        return Err("No format provided".into());
    };

    let for_agent = get_client_agent(headers, &appstate, &subject).await?;
    let display_refs_as_name = params.display_refs_as_name.unwrap_or(false);

    match format.as_str() {
        "csv" => {
            let exporter = CSVExporter {
                store,
                agent: &for_agent,
                display_refs_as_name,
            };

            let (name, csv) = exporter.resource_to_csv(&subject).await?;
            Ok(HttpResponse::Ok()
                .content_type("text/csv")
                .insert_header((
                    actix_web::http::header::CONTENT_DISPOSITION,
                    ContentDisposition {
                        disposition: DispositionType::Attachment,
                        parameters: vec![DispositionParam::Filename(name)],
                    },
                ))
                .body(csv))
        }
        _ => Err(format!("Unsupported format: {}", format).into()),
    }
}

struct CSVExporter<'a> {
    store: &'a Db,
    agent: &'a ForAgent,
    display_refs_as_name: bool,
}

impl<'a> CSVExporter<'a> {
    pub async fn resource_to_csv(&self, subject: &str) -> AtomicResult<(String, String)> {
        println!("Exporting resource to CSV: {}", subject);
        let resource = self
            .store
            .get_resource_extended(&subject.into(), false, self.agent)
            .await?
            .to_single();

        let binding = resource.get_classes(self.store).await?;

        let classes: Vec<&str> = binding.iter().map(|c| c.subject.as_str()).collect();

        // Check the classes of the resource to determine how to export it.
        if classes.contains(&urls::TABLE) {
            let prop_order = self.get_prop_order_from_table(&resource).await?;

            let data = self
                .build_csv_from_children(&resource, Some(prop_order))
                .await?;
            let Ok(Value::String(name)) = resource.get(urls::NAME) else {
                return Err("Resource does not have a name".into());
            };

            let filename = format!(
                "{}.csv",
                sanitize_filename::sanitize(name).replace(' ', "-")
            );
            Ok((filename, data))
        } else {
            Err("Resource does not have any supported classes".into())
        }
    }

    async fn get_prop_order_from_table(&self, resource: &Resource) -> AtomicResult<Vec<String>> {
        let class_value = resource.get(urls::CLASSTYPE_PROP)?;

        let propvals = match class_value {
            Value::AtomicUrl(subject) => self
                .store
                .get_resource_extended(&subject.clone(), false, self.agent)
                .await?
                .to_single()
                .get_propvals()
                .clone(),
            Value::NestedResource(nested) => match nested {
                SubResource::Subject(subject) => self
                    .store
                    .get_resource_extended(&subject.clone(), false, self.agent)
                    .await?
                    .to_single()
                    .get_propvals()
                    .clone(),
                SubResource::Nested(props) => props.clone(),
            },
            _ => return Err("Resource does not have any supported classtype".into()),
        };

        let mut requires = Value::ResourceArray(vec![]);
        if let Some(req) = propvals.get(urls::REQUIRES) {
            requires = req.clone();
        }

        let mut recommends = Value::ResourceArray(vec![]);
        if let Some(rec) = propvals.get(urls::RECOMMENDS) {
            recommends = rec.clone();
        }

        match (requires, recommends) {
            (Value::ResourceArray(requires), Value::ResourceArray(recommends)) => {
                let mut order = vec![];
                for value in requires.iter().chain(recommends.iter()) {
                    match value {
                        SubResource::Subject(subject) => {
                            order.push(subject.to_string());
                        }
                        SubResource::Nested(_) => {}
                    }
                }

                Ok(order)
            }
            _ => Err("Requires and Recommends must be arrays".into()),
        }
    }

    async fn build_csv_from_children(
        &self,
        resource: &Resource,
        prop_order: Option<Vec<String>>,
    ) -> AtomicResult<String> {
        let query = Query {
            property: Some(urls::PARENT.into()),
            value: Some(atomic_lib::Value::String(
                resource.get_subject().to_string(),
            )),
            filters: Vec::new(),
            limit: None,
            start_val: None,
            end_val: None,
            offset: 0,
            sort_by: Some(urls::CREATED_AT.into()),
            sort_desc: false,
            include_external: false,
            include_nested: true,
            exclude_trashed: false,
            for_agent: self.agent.clone(),
            // Indexed queries must be drive-scoped. Same derivation as the
            // forms and collections paths: the resource's `drive` propval,
            // else the prefix of its subject.
            drive: Some(
                resource
                    .get_drive()
                    .unwrap_or_else(|| drive_prefix_from_subject(resource.get_subject())),
            ),
            aggregation: None,
            expression_filters: Vec::new(),
        };

        let results = self.store.query(&query).await?;
        let mut body_csv = String::new();
        let mut encountered_properties = prop_order.unwrap_or_default();

        for item in results.resources.iter() {
            let mut line_vec: Vec<String> = vec![String::new(); encountered_properties.len()];
            line_vec.insert(0, item.get_subject().to_string());

            for (prop, value) in item.get_propvals().iter() {
                if prop == urls::PARENT || prop == urls::LAST_COMMIT {
                    continue;
                }

                let fixed_value = CSVExporter::escape_csv_value(self.value_to_string(value).await);

                if let Some(index) = encountered_properties.iter().position(|p| p == prop) {
                    line_vec[index + 1] = fixed_value;
                } else {
                    encountered_properties.push(prop.clone());
                    line_vec.push(fixed_value);
                }
            }

            let line = line_vec.join(",");
            body_csv.push_str(&format!("\n{}", line));
        }

        let header = self
            .create_csv_header_from_props(&encountered_properties)
            .await?;
        let csv = format!("{}{}", header, body_csv);

        Ok(csv)
    }

    async fn create_csv_header_from_props(&self, props: &[String]) -> AtomicResult<String> {
        let mut header = "subject".to_string();
        for prop in props.iter() {
            let name: String = if let Ok(resource_response) = self
                .store
                .get_resource_extended(&prop.clone().into(), true, self.agent)
                .await
            {
                resource_response
                    .to_single()
                    .get(urls::SHORTNAME)?
                    .to_string()
            } else {
                prop.to_string()
            };
            header.push_str(&format!(",{}", name));
        }

        Ok(header)
    }

    async fn value_to_string(&self, value: &Value) -> String {
        match value {
            Value::Timestamp(ts) => {
                // Convert the timestamp to a NaiveDateTime (no timezone)
                let seconds = ts / 1000;
                let remaining_nanoseconds = (ts % 1000) * 1_000_000; // Convert remaining milliseconds to nanoseconds

                let Some(datetime) =
                    DateTime::from_timestamp(seconds, remaining_nanoseconds as u32)
                else {
                    return ts.to_string();
                };

                // Format the DateTime<Utc> as a string in RFC3339 format (e.g., "2023-03-20T12:34:56Z")
                datetime.to_rfc3339()
            }
            Value::ResourceArray(values) => {
                let mut names = Vec::new();
                for v in values {
                    match v {
                        SubResource::Subject(subject) => {
                            names.push(self.get_name_from_subject(subject.as_str()).await)
                        }
                        SubResource::Nested(nested) => {
                            names.push(self.get_name_from_propvals(nested, "".to_string()))
                        }
                    }
                }
                names.join(", ")
            }
            Value::AtomicUrl(subject) => self.get_name_from_subject(subject.as_str()).await,
            _ => value.to_string(),
        }
    }

    async fn get_name_from_subject(&self, subject: &str) -> String {
        let Ok(resource_response) = self
            .store
            .get_resource_extended(&subject.into(), true, self.agent)
            .await
        else {
            return subject.to_string();
        };

        let resource = resource_response.to_single();

        self.get_name_from_propvals(resource.get_propvals(), resource.get_subject().to_string())
    }

    fn get_name_from_propvals(&self, propvals: &HashMap<String, Value>, subject: String) -> String {
        if !self.display_refs_as_name {
            return subject;
        }

        if let Some(value) = propvals.get(urls::DOWNLOAD_URL) {
            return value.to_string();
        }
        if let Some(value) = propvals.get(urls::NAME) {
            return value.to_string();
        }
        if let Some(value) = propvals.get(urls::SHORTNAME) {
            return value.to_string();
        }
        if let Some(value) = propvals.get(urls::FILENAME) {
            return value.to_string();
        }

        subject
    }

    fn escape_csv_value(value: String) -> String {
        let no_quotes = value.replace('"', "\"\"");
        let reg = regex::Regex::new(r"\n|,").unwrap();

        if reg.is_match(&no_quotes) {
            format!("\"{}\"", no_quotes)
        } else {
            no_quotes
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use atomic_lib::test_utils::init_store;

    /// Exporting a Table runs a `parent` query for its rows. Indexed queries
    /// must be drive-scoped, so this fails with "Indexed queries require a
    /// drive scope" if the exporter leaves `Query::drive` unset.
    #[tokio::test]
    async fn exports_table_rows_to_csv() {
        let store = init_store().await;

        let mut property = Resource::new_instance(urls::PROPERTY, &store)
            .await
            .unwrap();
        property
            .set(urls::SHORTNAME.into(), Value::Slug("email".into()), &store)
            .await
            .unwrap();
        property
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown("An email address".into()),
                &store,
            )
            .await
            .unwrap();
        property
            .set(
                urls::DATATYPE_PROP.into(),
                Value::AtomicUrl(urls::STRING.into()),
                &store,
            )
            .await
            .unwrap();
        property.save_locally(&store).await.unwrap();
        let property_subject = property.get_subject().to_string();

        let mut class = Resource::new_instance(urls::CLASS, &store).await.unwrap();
        class
            .set(
                urls::SHORTNAME.into(),
                Value::Slug("contact".into()),
                &store,
            )
            .await
            .unwrap();
        class
            .set(
                urls::DESCRIPTION.into(),
                Value::Markdown("A contact".into()),
                &store,
            )
            .await
            .unwrap();
        class
            .set(
                urls::REQUIRES.into(),
                Value::ResourceArray(vec![property_subject.clone().into()]),
                &store,
            )
            .await
            .unwrap();
        class.save_locally(&store).await.unwrap();
        let class_subject = class.get_subject().to_string();

        let mut table = Resource::new_instance(urls::TABLE, &store).await.unwrap();
        table
            .set(urls::NAME.into(), Value::String("Contacts".into()), &store)
            .await
            .unwrap();
        table
            .set(
                urls::CLASSTYPE_PROP.into(),
                Value::AtomicUrl(class_subject.clone().into()),
                &store,
            )
            .await
            .unwrap();
        table.save_locally(&store).await.unwrap();
        let table_subject = table.get_subject().to_string();

        for email in ["alice@example.com", "bob@example.com"] {
            let mut row = Resource::new_instance(&class_subject, &store)
                .await
                .unwrap();
            row.set(
                urls::PARENT.into(),
                Value::AtomicUrl(table_subject.clone().into()),
                &store,
            )
            .await
            .unwrap();
            row.set(
                property_subject.clone(),
                Value::String(email.into()),
                &store,
            )
            .await
            .unwrap();
            row.save_locally(&store).await.unwrap();
        }

        let exporter = CSVExporter {
            store: &store,
            agent: &ForAgent::Sudo,
            display_refs_as_name: false,
        };

        let (filename, csv) = exporter.resource_to_csv(&table_subject).await.unwrap();

        assert_eq!(filename, "Contacts.csv");
        let mut lines = csv.lines();
        let header = lines.next().unwrap();
        assert!(header.starts_with("subject,email"), "{header}");
        let rows: Vec<&str> = lines.collect();
        assert_eq!(rows.len(), 2, "one CSV line per table row: {csv}");
        assert!(csv.contains("alice@example.com"), "{csv}");
        assert!(csv.contains("bob@example.com"), "{csv}");
    }
}
