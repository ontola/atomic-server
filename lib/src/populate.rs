//! Populating a Store means adding resources to it.
//! Some of these are the core Atomic Data resources, such as the Property class.
//! These base models are required for having a functioning store.

use crate::{
    datatype::DataType,
    errors::AtomicResult,
    parse::ParseOpts,
    schema::{Class, Property},
    urls, Storelike, Value,
};

/// Populates a store with some of the most fundamental Properties and Classes needed to bootstrap the whole.
/// This is necessary to prevent a loop where Property X (like the `shortname` Property)
/// cannot be added, because it's Property Y (like `description`) has to be fetched before it can be added,
/// which in turn has property Property X (`shortname`) which needs to be fetched before.
/// https://github.com/atomicdata-dev/atomic-server/issues/60
pub async fn populate_base_models(store: &impl Storelike) -> AtomicResult<()> {
    // Start with adding the most fundamental properties - the properties for Properties

    let properties = vec![
        Property {
            class_type: None,
            data_type: DataType::Slug,
            shortname: "shortname".into(),
            description: "A short name of something. It can only contain letters, numbers and dashes `-`. Use dashes to denote spaces between words. Not case sensitive - lowercase only. Useful in programming contexts where the user should be able to type something short to identify a specific thing.".into(),
            subject: urls::SHORTNAME.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::Markdown,
            shortname: "description".into(),
            description: "A textual description of something. When making a description, make sure that the first few words tell the most important part. Give examples. Since the text supports markdown, you're free to use links and more.".into(),
            subject: urls::DESCRIPTION.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::CLASS.into()),
            data_type: DataType::ResourceArray,
            shortname: "is-a".into(),
            description: "A list of Classes of which the thing is an instance of. The Classes of a Resource determine which Properties are recommended and required.".into(),
            subject: urls::IS_A.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::DATATYPE_CLASS.into()),
            data_type: DataType::AtomicUrl,
            shortname: "datatype".into(),
            description: "The Datatype of a property, such as String or Timestamp.".into(),
            subject: urls::DATATYPE_PROP.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::CLASS.into()),
            data_type: DataType::AtomicUrl,
            shortname: "classtype".into(),
            description:
                "The class-type indicates that the Atomic URL should be an instance of this class.\n\nThis can be used inside [`Property`](https://atomicdata.dev/classes/Property) instances where the [`datatype`](https://atomicdata.dev/properties/datatype) is either [`Resource`](https://atomicdata.dev/datatypes/resource) or [`ResourceArray`](https://atomicdata.dev/datatypes/resourceArray).\n\nSo for example if we have a `Property` called `friend`, the `classType` can be `Person`."
               .into(),
            subject: urls::CLASSTYPE_PROP.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::PROPERTY.into()),
            data_type: DataType::ResourceArray,
            shortname: "recommends".into(),
            description: "The Properties that are not required, but recommended for this Class.".into(),
            subject: urls::RECOMMENDS.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::PROPERTY.into()),
            data_type: DataType::ResourceArray,
            shortname: "requires".into(),
            description: "The Properties that are required for this Class.".into(),
            subject: urls::REQUIRES.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::AtomicUrl,
            shortname: "parent".into(),
            description: "The parent of a Resource sets the hierarchical structure of the Resource, and therefore also the rights / grants. It is used for both navigation, structure and authorization. Parents are the inverse of [children](https://atomicdata.dev/properties/children).".into(),
            subject: urls::PARENT.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::ResourceArray,
            shortname: "allows-only".into(),
            description: "Restricts this Property to only the values inside this one. This essentially turns the Property into an `enum`.".into(),
            subject: urls::ALLOWS_ONLY.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::Boolean,
            shortname: "is-dynamic".into(),
            description: "If this is true, a Property is calculated server side and should therefore not appear in forms.".into(),
            subject: urls::IS_DYNAMIC.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::Boolean,
            shortname: "is-locked".into(),
            description: "If this is true, the Property should probably not be edited, because doing so could lead to serious errors.".into(),
            subject: urls::IS_LOCKED.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::Slug,
            shortname: "subdomain".into(),
            description: "The subdomain that identifies a Drive on a server. For example, in `joep.atomicdata.dev`, the subdomain is `joep`.".into(),
            subject: urls::SUBDOMAIN.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::DRIVE.into()),
            data_type: DataType::AtomicUrl,
            shortname: "initial-drive".into(),
            description: "The DID of the drive that should be mapped to the current host.".into(),
            subject: urls::INITIAL_DRIVE.into(),
            allows_only: None,
        },
        Property {
            class_type: Some(urls::DRIVE.into()),
            data_type: DataType::AtomicUrl,
            shortname: "personal-drive".into(),
            description: "The agent's personal (private) drive on this server. Clients use this as home and for agent-scoped data such as shared-with-me. At most one per agent.".into(),
            subject: urls::PERSONAL_DRIVE.into(),
            allows_only: None,
        },
        Property {
            class_type: None,
            data_type: DataType::ResourceArray,
            shortname: "shared-with-me".into(),
            description: "Resources this agent can access via invites or other shares. Clients often show these in a Shared with me list.".into(),
            subject: urls::SHARED_WITH_ME.into(),
            allows_only: None,
        },
    ];
    let classes = vec![
        Class {
            requires: vec![urls::SHORTNAME.into(), urls::DATATYPE_PROP.into(), urls::DESCRIPTION.into()],
            recommends: vec![urls::CLASSTYPE_PROP.into(), urls::IS_DYNAMIC.into(), urls::IS_LOCKED.into(), urls::ALLOWS_ONLY.into()],
            shortname: "property".into(),
            description: "A Property is a single field in a Class. It's the thing that a property field in an Atom points to. An example is `birthdate`. An instance of Property requires various Properties, most notably a `datatype` (e.g. `string` or `integer`), a human readable `description` (such as the thing you're reading), and a `shortname`.".into(),
            subject: urls::PROPERTY.into(),
        },
        Class {
            requires: vec![urls::SHORTNAME.into(), urls::DESCRIPTION.into()],
            recommends: vec![urls::RECOMMENDS.into(), urls::REQUIRES.into()],
            shortname: "class".into(),
            description: "A Class describes an abstract concept, such as 'Person' or 'Blogpost'. It describes the data shape of data (which fields are required and recommended) and explains what the concept represents. It is convention to use Uppercase in its URL.Resources use the [is-a](https://atomicdata.dev/properties/isA) attribute to indicate which classes they are instances of. Note that in Atomic Data, a Resource can have several Classes - not just a single one.".into(),
            subject: urls::CLASS.into(),
        },
        Class {
            requires: vec![urls::SHORTNAME.into(), urls::DESCRIPTION.into()],
            recommends: vec![],
            shortname: "datatype".into(),
            description:
                "A Datatype describes a possible type of value, such as 'string' or 'integer'.".into(),
            subject: urls::DATATYPE_CLASS.into(),
        },
        Class {
            requires: vec![],
            recommends: vec![
                urls::PUBLIC_KEY.into(),
                urls::NAME.into(),
                urls::DESCRIPTION.into(),
                urls::PERSONAL_DRIVE.into(),
                urls::SHARED_WITH_ME.into(),
                urls::DRIVES.into(),
            ],
            shortname: "agent".into(),
            description:
                "An Agent is a user that can create or modify data. For DID-based agents (did:ad:agent:{publicKey}), the public key is derived from the subject.".into(),
            subject: urls::AGENT.into(),
        }
    ];

    for p in properties {
        let mut resource = p.to_resource();
        resource.set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl("https://atomicdata.dev/properties".into()),
        );
        store
            .add_resource_opts(&resource, false, true, true)
            .await?;
    }

    for c in classes {
        let mut resource = c.to_resource();
        resource.set_unsafe(
            urls::PARENT.into(),
            Value::AtomicUrl("https://atomicdata.dev/classes".into()),
        );
        store
            .add_resource_opts(&resource, false, true, true)
            .await?;
    }

    Ok(())
}

/// Imports the Atomic Data Core items (the entire atomicdata.dev Ontology / Vocabulary)
pub async fn populate_default_store(store: &impl Storelike) -> AtomicResult<()> {
    store
        .import(
            include_str!("../defaults/default_store.json"),
            &ParseOpts::default(),
        )
        .await
        .map_err(|e| format!("Failed to import default_store.json: {e}"))?;
    store
        .import(
            include_str!("../defaults/chatroom.json"),
            &ParseOpts::default(),
        )
        .await
        .map_err(|e| format!("Failed to import chatroom.json: {e}"))?;
    store
        .import(
            include_str!("../defaults/table.json"),
            &ParseOpts::default(),
        )
        .await
        .map_err(|e| format!("Failed to import table.json: {e}"))?;
    store
        .import(
            include_str!("../defaults/ontologies.json"),
            &ParseOpts::default(),
        )
        .await
        .map_err(|e| format!("Failed to import ontologies.json: {e}"))?;
    store
        .import(include_str!("../defaults/ai.json"), &ParseOpts::default())
        .await
        .map_err(|e| format!("Failed to import ai.json: {e}"))?;
    store
        .import(
            include_str!("../defaults/plugins.json"),
            &ParseOpts::default(),
        )
        .await
        .map_err(|e| format!("Failed to import plugins.json: {e}"))?;
    Ok(())
}

/// Bootstraps the store with core models and default ontologies.
/// Uses `begin_batch`/`commit_batch` to fold all writes into a single DB transaction.
pub async fn bootstrap(store: &impl Storelike) -> AtomicResult<()> {
    // Skip on already-seeded stores. This must be a local storage check,
    // not `get_resource`: `get_resource` may fetch external Atomic URLs
    // and can make a fresh store look seeded after fetching only the
    // sentinel resource.
    if store.has_stored_resource(&crate::urls::SHORTNAME.into()) {
        tracing::debug!(
            "populate::bootstrap: store already seeded, skipping"
        );
        return Ok(());
    }

    tracing::info!("populate::bootstrap: seeding base models and ontologies");
    store.begin_batch();
    populate_base_models(store).await?;
    populate_default_store(store).await?;
    store.commit_batch()?;
    Ok(())
}
