//! Populating a Store means adding resources to it.
//! Some of these are the core Atomic Data resources, such as the Property class.
//! These base models are required for having a functioning store.
//! Other populate methods help to set up an Atomic Server, by creating a basic file hierarcy and creating default collections.

use crate::{
    agents,
    datatype::DataType,
    errors::AtomicResult,
    parse::ParseOpts,
    schema::{Class, Property},
    storelike::Query,
    urls, Resource, Storelike, Subject, Value,
};

const DEFAULT_ONTOLOGY_PATH: &str = "defaultOntology";

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
        }
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
            requires: vec![urls::PUBLIC_KEY.into()],
            recommends: vec![urls::NAME.into(), urls::DESCRIPTION.into(), urls::DRIVES.into()],
            shortname: "agent".into(),
            description:
                "An Agent is a user that can create or modify data. It has two keys: a private and a public one. The private key should be kept secret. The public key is used to verify signatures (on [Commits](https://atomicdata.dev/classes/Commit)) set by the of the Agent.".into(),
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

/// Creates a Drive resource at the base URL. Does not set rights. Use set_drive_rights for that.
/// Generates a new keypair for the drive and computes the drive hash
/// (truncated SHA-256 of "atomicdata.drive" || public_key → 16 bytes, hex-encoded).
pub async fn create_drive(store: &impl Storelike) -> AtomicResult<()> {
    let mut drive = store.get_resource_new(&"internal:/".into()).await;
    drive.set_class(urls::DRIVE);
    let name = store
        .get_base_domain()
        .unwrap_or_else(|| "Atomic Server".to_string());
    drive.set_string(urls::NAME.into(), &name, store).await?;

    // Generate a keypair for the drive's cryptographic identity
    let keypair = agents::generate_public_key(&agents::encode_base64(
        &ring::rand::generate::<[u8; 32]>(&ring::rand::SystemRandom::new())
            .map_err(|e| format!("Failed to generate drive key seed: {}", e))?
            .expose(),
    ));

    // Compute drive hash: truncated_SHA256("atomicdata.drive" || public_key_bytes) → 16 bytes → hex
    let public_key_bytes = agents::decode_base64(&keypair.public)?;
    use ring::digest;
    let mut hash_input = b"atomicdata.drive".to_vec();
    hash_input.extend_from_slice(&public_key_bytes);
    let full_hash = digest::digest(&digest::SHA256, &hash_input);
    let drive_hash_hex = full_hash.as_ref()[..16]
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<String>();

    drive.set_unsafe(urls::DRIVE_PUBLIC_KEY.into(), Value::String(keypair.public));
    drive.set_unsafe(urls::DRIVE_HASH.into(), Value::String(drive_hash_hex));

    drive.save_locally(store).await?;

    Ok(())
}

/// Creates a new DID-native Drive resource.
/// Generates a new keypair for the drive and computes the drive hash.
/// The subject will be `did:ad:{genesis_signature}`.
pub async fn create_did_drive(store: &impl Storelike, subdomain: Option<String>) -> AtomicResult<Subject> {
    // Create a new resource with a dummy subject (will be overwritten by save_as_genesis)
    let mut drive = Resource::new("did:ad:placeholder".into());
    drive.set_class(urls::DRIVE);

    if let Some(sub) = subdomain {
        drive.set_unsafe(urls::SUBDOMAIN.into(), Value::Slug(sub));
    }

    let name = store
        .get_base_domain()
        .unwrap_or_else(|| "Atomic Server".to_string());
    drive.set_string(urls::NAME.into(), &name, store).await?;

    // Generate a keypair for the drive's cryptographic identity
    let (public_key, _seed) = crate::drive::generate_drive_keypair();
    let public_key_base64 = crate::agents::encode_base64(&public_key);

    // Compute drive hash: truncated_SHA256("atomicdata.drive" || public_key_bytes) → 16 bytes → hex
    let hash = crate::drive::compute_drive_hash(&public_key);
    let drive_hash_hex = hash.iter().map(|b| format!("{:02x}", b)).collect::<String>();

    drive.set_unsafe(
        urls::DRIVE_PUBLIC_KEY.into(),
        Value::String(public_key_base64),
    );
    drive.set_unsafe(urls::DRIVE_HASH.into(), Value::String(drive_hash_hex));

    let commit_res = drive.save_as_genesis(store).await?;
    let subject = commit_res
        .resource_new
        .ok_or("Failed to create drive resource")?
        .get_subject()
        .clone();

    Ok(subject)
}

pub async fn create_default_ontology(store: &impl Storelike) -> AtomicResult<()> {
    let mut drive = store.get_resource(&"/".into()).await?;

    let ontology_subject = format!("{}{}", drive.get_subject().as_str(), DEFAULT_ONTOLOGY_PATH);

    // If the ontology already exists, don't change it.
    if store
        .get_resource(&ontology_subject.as_str().into())
        .await
        .is_ok()
    {
        return Ok(());
    }

    let mut ontology = store
        .get_resource_new(&ontology_subject.as_str().into())
        .await;

    ontology.set_class(urls::ONTOLOGY);
    ontology
        .set_string(urls::SHORTNAME.into(), "ontology", store)
        .await?;
    ontology
        .set_string(
            urls::DESCRIPTION.into(),
            "Default ontology for this drive",
            store,
        )
        .await?;
    ontology
        .set_string(urls::PARENT.into(), drive.get_subject().as_str(), store)
        .await?;
    ontology
        .set(urls::CLASSES.into(), Value::ResourceArray(vec![]), store)
        .await?;
    ontology
        .set(urls::PROPERTIES.into(), Value::ResourceArray(vec![]), store)
        .await?;
    ontology
        .set(urls::INSTANCES.into(), Value::ResourceArray(vec![]), store)
        .await?;
    ontology.save_locally(store).await?;

    drive
        .set_string(
            urls::DEFAULT_ONTOLOGY.into(),
            &ontology.get_subject().to_string(),
            store,
        )
        .await?;
    drive.push(
        urls::SUBRESOURCES,
        crate::values::SubResource::Subject(ontology.get_subject().clone()),
        false,
    )?;
    drive.save_locally(store).await?;
    Ok(())
}

/// Adds rights to the default agent to the Drive resource (at the base URL). Optionally give Public Read rights.
pub async fn set_drive_rights(store: &impl Storelike, public_read: bool) -> AtomicResult<()> {
    // Now let's add the agent as the Root user and provide write access
    let mut drive = store.get_resource(&"/".into()).await?;
    let write_agent = store.get_default_agent()?.subject;
    let read_agent = write_agent.clone();

    drive.push(urls::WRITE, write_agent.into(), true)?;
    drive.push(urls::READ, read_agent.into(), true)?;
    if public_read {
        drive.push(urls::READ, urls::PUBLIC_AGENT.into(), true)?;
    }

    if let Err(_no_description) = drive.get(urls::DESCRIPTION) {
        let ontology_url = format!("{}{}", drive.get_subject().as_str(), DEFAULT_ONTOLOGY_PATH);
        drive.set_string(urls::DESCRIPTION.into(), &format!(r#"## Welcome to your Atomic-Server!
### Getting started
If you just started this server, you should have seen an invite link in the terminal output. Use that to create your first Agent and get write access.

Note that, by default, all resources are `public`. You can edit this by opening the context menu (the three dots in the navigation bar), and going to `share`.

Once you've setup an agent you should start editing your schema using ontologies.
We've created a [default ontology]({}) for you but you can create more if you want.

Next create some resources by clicking on the plus button in the sidebar.
You can create folders to organise your resources.

To use the data in your web apps checkout our client libraries: [@tomic/lib](https://docs.atomicdata.dev/js), [@tomic/react](https://docs.atomicdata.dev/usecases/react) and [@tomic/svelte](https://docs.atomicdata.dev/svelte)
Use [@tomic/cli](https://docs.atomicdata.dev/js-cli) to generate typed ontologies inside your code.
"#, ontology_url), store).await?;
    }
    drive.save_locally(store).await?;
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

/// Generates collections for classes, such as `/agent` and `/collection`.
/// Requires a `self_url` to be set in the store.
pub async fn populate_collections(store: &impl Storelike) -> AtomicResult<()> {
    let mut query = Query::new_class(urls::CLASS);
    query.include_external = true;
    let result = store.query(&query).await?;

    for subject in result.subjects {
        let mut collection =
            crate::collections::create_collection_resource_for_class(store, subject.as_str()).await?;
        collection.save_locally(store).await?;
    }

    Ok(())
}

#[cfg(feature = "db")]
/// Adds default Endpoints (versioning) to the Db.
/// Makes sure they are fetchable
pub async fn populate_endpoints(store: &crate::Db) -> AtomicResult<()> {
    let endpoints = store.get_endpoints();
    let endpoints_collection = "/endpoints";
    for endpoint in endpoints {
        tracing::debug!("Populating endpoint: {}", endpoint.path);
        let mut resource = endpoint.to_resource(store).await?;
        resource
            .set(
                urls::PARENT.into(),
                Value::AtomicUrl(endpoints_collection.into()),
                store,
            )
            .await?;
        resource.save_locally(store).await?;
    }
    tracing::info!("Endpoints populated.");
    Ok(())
}

#[cfg(feature = "db")]
/// Adds default Endpoints (versioning) to the Db.
/// Makes sure they are fetchable
pub async fn populate_importer(store: &crate::Db) -> AtomicResult<()> {
    // let base = store
    //     .get_self_url()
    //     .ok_or("No self URL in this Store - required for populating importer")?;
    let mut importer = crate::Resource::new("/import".into());
    importer.set_class(urls::IMPORTER);
    importer
        .set(urls::PARENT.into(), Value::AtomicUrl("/".into()), store)
        .await?;
    importer
        .set(urls::NAME.into(), Value::String("Import".into()), store)
        .await?;
    importer.save_locally(store).await?;
    Ok(())
}

#[cfg(feature = "db")]
/// Adds items to the SideBar as subresources.
/// Useful for helping a new user get started.
pub async fn populate_sidebar_items(store: &crate::Db) -> AtomicResult<()> {
    let mut drive = store.get_resource(&"/".into()).await?;
    let arr = vec!["import", "collections"];
    for item in arr {
        drive.push(urls::SUBRESOURCES, item.into(), true)?;
    }
    drive.save_locally(store).await?;
    Ok(())
}

/// Runs all populate commands. Optionally runs index (blocking), which can be slow!
#[cfg(feature = "db")]
pub async fn populate_all(store: &crate::Db) -> AtomicResult<()> {
    populate_base_models(store)
        .await
        .map_err(|e| format!("Failed to populate default store. {}", e))?;
    populate_default_store(store)
        .await
        .map_err(|e| format!("Failed to populate default store. {}", e))?;

    // Use try_join! to run the rest concurrently
    tracing::info!("Populating Drive...");
    create_drive(store)
        .await
        .map_err(|e| format!("Failed to create drive. {}", e))?;
    tracing::info!("Populating Ontology...");
    create_default_ontology(store)
        .await
        .map_err(|e| format!("Failed to create default ontology. {}", e))?;
    tracing::info!("Setting Drive Rights...");
    set_drive_rights(store, true).await?;
    tracing::info!("Populating Collections...");
    populate_collections(store)
        .await
        .map_err(|e| format!("Failed to populate collections. {}", e))?;
    tracing::info!("Populating Endpoints...");
    populate_endpoints(store)
        .await
        .map_err(|e| format!("Failed to populate endpoints. {}", e))?;
    tracing::info!("Populating Importer...");
    populate_importer(store)
        .await
        .map_err(|e| format!("Failed to populate importer. {}", e))?;
    tracing::info!("Populating Sidebar...");
    populate_sidebar_items(store)
        .await
        .map_err(|e| format!("Failed to populate sidebar items. {}", e))?;
    tracing::info!("Populate ALL Finished!");
    Ok(())
}
