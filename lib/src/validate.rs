//! Validate the Store and create a ValidationReport.
//!
//! This is a local check used by `atomic-cli validate`. Parsing already
//! rejects malformed values, so this pass is about required Class properties
//! and whether linked Properties/Classes are present in the store.

/// Checks Atomic Data in the store for validity.
///
/// Validates:
///
/// - If the Values can be parsed using their Datatype
/// - If all required fields of the class are present
/// - If the URLs are publicly accessible (when `fetch_items` is true)
///
/// Returns a report instead of throwing.
pub async fn validate_store(
    store: &impl crate::Storelike,
    fetch_items: bool,
) -> crate::validate::ValidationReport {
    type Error = String;
    let mut resource_count: usize = 0;
    let mut atom_count: usize = 0;
    let mut unfetchable: Vec<(String, Error)> = Vec::new();
    let mut invalid_value: Vec<(crate::Atom, Error)> = Vec::new();
    let mut unfetchable_props: Vec<(String, Error)> = Vec::new();
    let mut unfetchable_classes: Vec<(String, Error)> = Vec::new();
    // subject, property, class
    let mut missing_props: Vec<(String, String, String)> = Vec::new();
    for resource in store.all_resources(true) {
        let subject = resource.get_subject();
        let propvals = resource.get_propvals();
        resource_count += 1;

        if fetch_items {
            match crate::client::fetch_resource(
                subject.as_str(),
                store,
                store.get_default_agent().ok().as_ref(),
            )
            .await
            {
                Ok(_) => {}
                Err(e) => unfetchable.push((subject.to_string(), e.to_string())),
            }
        }

        let mut found_props: Vec<String> = Vec::new();

        for (prop_url, value) in propvals {
            atom_count += 1;

            let property = match store.get_property(prop_url).await {
                Ok(prop) => prop,
                Err(e) => {
                    unfetchable_props.push((prop_url.clone(), e.to_string()));
                    continue;
                }
            };

            // Maybe this is no longer needed, because no store uses strings anymore
            match crate::Value::new(&value.to_string(), &property.data_type) {
                Ok(_) => {}
                Err(e) => invalid_value.push((
                    crate::Atom::new(subject.clone(), prop_url.clone(), value.clone()),
                    e.to_string(),
                )),
            };
            found_props.push(prop_url.clone());
        }
        let classes = match store.get_classes_for_subject(subject).await {
            Ok(classes) => classes,
            Err(e) => {
                unfetchable_classes.push((subject.to_string(), e.to_string()));
                continue;
            }
        };
        for class in classes {
            for required_prop_subject in class.requires {
                match store.get_property(&required_prop_subject).await {
                    Ok(required_prop) => {
                        if !found_props.contains(&required_prop.subject) {
                            missing_props.push((
                                subject.to_string(),
                                required_prop.subject.clone(),
                                class.subject.clone(),
                            ));
                        }
                    }
                    Err(e) => unfetchable.push((required_prop_subject, e.to_string())),
                }
            }
        }
    }
    crate::validate::ValidationReport {
        unfetchable,
        unfetchable_classes,
        unfetchable_props,
        invalid_value,
        missing_props,
        resource_count,
        atom_count,
    }
}

pub struct ValidationReport {
    pub resource_count: usize,
    pub atom_count: usize,
    pub unfetchable: Vec<(String, String)>,
    pub invalid_value: Vec<(crate::Atom, String)>,
    pub unfetchable_props: Vec<(String, String)>,
    pub unfetchable_classes: Vec<(String, String)>,
    pub missing_props: Vec<(String, String, String)>,
}

impl ValidationReport {
    pub fn is_valid(&self) -> bool {
        self.unfetchable.is_empty()
            && self.unfetchable_classes.is_empty()
            && self.unfetchable_props.is_empty()
            && self.invalid_value.is_empty()
            && self.missing_props.is_empty()
    }
}

impl std::fmt::Display for ValidationReport {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        if self.is_valid() {
            fmt.write_str("Valid!")?;
            return Ok(());
        }
        for (subject, error) in &self.unfetchable {
            fmt.write_str(&format!("Cannot fetch Resource {}: {} \n", subject, error))?;
        }
        for (subject, error) in &self.unfetchable_classes {
            fmt.write_str(&format!("Cannot fetch Class {}: {} \n", subject, error))?;
        }
        for (subject, error) in &self.unfetchable_props {
            fmt.write_str(&format!("Cannot fetch Property {}: {} \n", subject, error))?;
        }
        for (atom, error) in &self.invalid_value {
            fmt.write_str(&format!("Invalid value {:?}: {} \n", atom, error))?;
        }
        for (subject, property, class) in &self.missing_props {
            fmt.write_str(&format!(
                "Resource {} missing required property {} (class {}) \n",
                subject, property, class
            ))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use crate::Storelike;

    #[tokio::test]
    async fn validate_populated() {
        let store = crate::Store::init().await.unwrap();
        store.populate().await.unwrap();
        let report = store.validate().await;
        assert!(
            report.atom_count > 30,
            "expected populated store to have more than 30 atoms, got {}",
            report.atom_count
        );
        assert!(
            report.resource_count > 5,
            "expected populated store to have more than 5 resources, got {}",
            report.resource_count
        );
        assert!(
            report.is_valid(),
            "populated default store should validate: {}",
            report
        );
    }
}
