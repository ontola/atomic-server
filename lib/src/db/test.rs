use crate::{agents::ForAgent, urls, Subject, Value};

use super::*;
use ntest::timeout;

use std::sync::Mutex;
use tokio::sync::OnceCell;

static DB: OnceCell<Mutex<Db>> = OnceCell::const_new();

/// Share the Db instance between tests. Otherwise, all tests try to init the same location on disk and throw errors.
/// Note that not all behavior can be properly tested with a shared database.
/// If you need a clean one, juts call init("someId").
pub async fn get_shared_db() -> &'static Mutex<Db> {
    DB.get_or_init(|| async {
        let store = Db::init_temp("shared").await.unwrap();
        crate::test_utils::setup_test_env(&store).await.unwrap();
        Mutex::new(store)
    })
    .await
}

#[tokio::test]
#[timeout(30000)]
async fn basic() {
    let store = get_shared_db().await.lock().unwrap().clone();
    // We can create a new Resource, linked to the store.
    // Note that since this store only exists in memory, it's data cannot be accessed from the internet.
    // Let's make a new Property instance!
    let mut new_resource =
        crate::Resource::new_instance("https://atomicdata.dev/classes/Property", &store)
            .await
            .unwrap();
    // And add a description for that Property
    new_resource
        .set_shortname("description", "the age of a person", &store)
        .await
        .unwrap();
    new_resource
        .set_shortname("shortname", "age", &store)
        .await
        .unwrap();
    new_resource
        .set_shortname("datatype", crate::urls::INTEGER, &store)
        .await
        .unwrap();
    // Changes are only applied to the store after saving them explicitly.
    new_resource.save_locally(&store).await.unwrap();
    // The modified resource is saved to the store after this

    // A subject URL has been created automatically.
    let subject = new_resource.get_subject();
    let fetched_new_resource = store.get_resource(subject).await.unwrap();
    let description_val = fetched_new_resource
        .get_shortname("description", &store)
        .await
        .unwrap()
        .to_string();
    assert!(description_val == "the age of a person");

    // Try removing something
    store
        .get_resource(&crate::urls::CLASS.into())
        .await
        .unwrap();
    store
        .remove_resource(&crate::urls::CLASS.into())
        .await
        .unwrap();
    // Should throw an error, because can't remove non-existent resource
    store
        .remove_resource(&crate::urls::CLASS.into())
        .await
        .unwrap_err();
    // Should throw an error, because resource is deleted
    store.get_propvals(crate::urls::CLASS).unwrap_err();

    let all_local_resources = store.all_resources(false).count();
    let all_resources = store.all_resources(true).count();
    assert!(all_local_resources < all_resources);
}

#[tokio::test]
/// Check if a resource is properly removed from the DB after a delete command.
/// Also counts commits.
async fn destroy_resource_and_check_collection_and_commits() {
    let store = Db::init_temp("counter").await.unwrap();
    crate::test_utils::setup_test_env(&store).await.unwrap();
    let for_agent = &ForAgent::Public;
    let agents_url = "internal:/agents".to_string();
    let agents_collection_1 = store
        .get_resource_extended(&agents_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    println!(
        "Agents collection 1: {}",
        agents_collection_1.to_json_ad(None).unwrap()
    );
    let agents_collection_count_1 = agents_collection_1
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    assert_eq!(
        agents_collection_count_1, 1,
        "There should be 1 agent in this collection initially (the agent created during init)"
    );

    // We will count the commits, and check if they've incremented later on.
    let commits_url = "internal:/commits".to_string();
    let commits_collection_1 = store
        .get_resource_extended(&commits_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    let commits_collection_count_1 = commits_collection_1
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    println!("Commits collection count 1: {}", commits_collection_count_1);

    // Create a new agent, check if it is added to the new Agents collection as a Member.
    let mut resource = crate::agents::Agent::new(None)
        .unwrap()
        .to_resource()
        .unwrap();
    let _res = resource.save_locally(&store).await.unwrap();
    let agents_collection_2 = store
        .get_resource_extended(&agents_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    let agents_collection_count_2 = agents_collection_2
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    assert_eq!(
        agents_collection_count_2, 2,
        "The new Agent resource did not increase the collection member count from 1 to 2."
    );

    let commits_collection_2 = store
        .get_resource_extended(&commits_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    let commits_collection_count_2 = commits_collection_2
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    println!("Commits collection count 2: {}", commits_collection_count_2);
    assert_eq!(
        commits_collection_count_2,
        commits_collection_count_1 + 1,
        "The commits collection did not increase after saving the resource."
    );

    let clone = _res.resource_new.clone().unwrap();
    let resp = _res.resource_new.unwrap().destroy(&store).await.unwrap();
    assert!(resp.resource_new.is_none());
    assert_eq!(
        resp.resource_old
            .as_ref()
            .unwrap()
            .to_json_ad(None)
            .unwrap(),
        clone.to_json_ad(None).unwrap(),
        "JSON AD differs between removed resource and resource passed back from commit"
    );
    assert!(resp.resource_old.is_some());
    let agents_collection_3 = store
        .get_resource_extended(&agents_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    let agents_collection_count_3 = agents_collection_3
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    assert_eq!(
        agents_collection_count_3, 1,
        "The collection count did not decrease after destroying the resource."
    );

    let commits_collection_3 = store
        .get_resource_extended(&commits_url.as_str().into(), false, for_agent)
        .await
        .unwrap();
    let commits_collection_count_3 = commits_collection_3
        .to_single()
        .get(crate::urls::COLLECTION_MEMBER_COUNT)
        .unwrap()
        .to_int()
        .unwrap();
    println!("Commits collection count 3: {}", commits_collection_count_3);
    assert_eq!(
        commits_collection_count_3,
        commits_collection_count_2 + 1,
        "The commits collection did not increase after destroying the resource."
    );
}

#[tokio::test]
async fn get_extended_resource_pagination() {
    let store = Db::init_temp("get_extended_resource_pagination")
        .await
        .unwrap();
    crate::test_utils::setup_test_env(&store).await.unwrap();
    let subject = format!(
        "{}/commits?current_page=2&page_size=99999",
        "http://localhost"
    );
    let for_agent = &ForAgent::Public;
    if store
        .get_resource_extended(&subject.as_str().into(), false, for_agent)
        .await
        .is_ok()
    {
        panic!("Page 2 should not exist, because page size is set to a high value.")
    }
    // let subject = "https://atomicdata.dev/classes?current_page=2&page_size=1";
    let subject_with_page_size = format!("{}&page_size=1", subject);
    let resource = store
        .get_resource_extended(
            &subject_with_page_size.as_str().into(),
            false,
            &ForAgent::Public,
        )
        .await
        .unwrap()
        .to_single();
    let cur_page = resource
        .get(urls::COLLECTION_CURRENT_PAGE)
        .unwrap()
        .to_int()
        .unwrap();
    assert_eq!(cur_page, 2);
    assert_eq!(resource.get_subject().as_str(), &subject_with_page_size);
}

/// Generate a bunch of resources, query them.
/// Checks if cache is properly invalidated on modifying or deleting resources.
#[tokio::test]
async fn queries() {
    // Re-using the same instance can cause issues with testing concurrently.
    // let store = &DB.lock().unwrap().clone();
    let store_owned = Db::init_temp("queries").await.unwrap();
    crate::test_utils::setup_test_env(&store_owned).await.unwrap();
    let store = &store_owned;

    let demo_val = Value::Slug("myval".to_string());
    let demo_reference = Value::AtomicUrl(urls::PARAGRAPH.into());

    let count = 10;
    let limit = 5;
    assert!(
        count > limit,
        "following tests might not make sense if count is less than limit"
    );

    let prop_filter = urls::DESTINATION;
    let sort_by = urls::DESCRIPTION;
    let mut subject_to_delete = "".to_string();

    for _x in 0..count {
        let mut demo_resource = Resource::new_generate_subject(store).unwrap();
        // We make one resource public
        if _x == 1 {
            demo_resource
                .set(urls::READ.into(), vec![urls::PUBLIC_AGENT].into(), store)
                .await
                .unwrap();
        } else if _x == 2 {
            subject_to_delete = demo_resource.get_subject().to_string();
        }
        demo_resource
            .set(urls::DESTINATION.into(), demo_reference.clone(), store)
            .await
            .unwrap();
        demo_resource
            .set(urls::SHORTNAME.into(), demo_val.clone(), store)
            .await
            .unwrap();
        demo_resource
            .set(
                sort_by.into(),
                Value::Markdown(crate::utils::random_string(10)),
                store,
            )
            .await
            .unwrap();
        demo_resource.save(store).await.unwrap();
    }

    let mut q = Query {
        property: Some(prop_filter.into()),
        value: Some(demo_reference.clone()),
        limit: Some(limit),
        start_val: None,
        end_val: None,
        offset: 0,
        sort_by: None,
        sort_desc: false,
        include_external: true,
        include_nested: false,
        for_agent: ForAgent::Sudo,
        drive: None,
    };
    let res = store.query(&q).await.unwrap();
    assert_eq!(
        res.count, count,
        "number of references without property filter"
    );
    assert_eq!(limit, res.subjects.len(), "limit");

    q.property = None;
    q.value = Some(demo_val);
    let res = store.query(&q).await.unwrap();
    assert_eq!(res.count, count, "literal value, no property filter");

    q.offset = 9;
    let res = store.query(&q).await.unwrap();
    assert_eq!(res.subjects.len(), count - q.offset, "offset");
    assert_eq!(res.resources.len(), 0, "no nested resources");

    q.offset = 0;
    q.include_nested = true;
    let res = store.query(&q).await.unwrap();
    assert_eq!(res.resources.len(), limit, "nested resources");

    q.sort_by = Some(sort_by.into());
    q.drive = Some(Subject::from("internal:/"));
    let mut res = store.query(&q).await.unwrap();
    assert!(!res.resources.is_empty(), "resources should be returned");
    let mut prev_resource = res.resources[0].clone();
    // For one resource, we will change the order by changing its value
    let mut resource_changed_order_opt = None;
    for (i, r) in res.resources.iter_mut().enumerate() {
        let previous = prev_resource.get(sort_by).unwrap().to_string();
        let current = r.get(sort_by).unwrap().to_string();
        assert!(
            previous <= current,
            "should be ascending: {} - {}",
            previous,
            current
        );
        // We change the order!
        if i == 4 {
            r.set(sort_by.into(), Value::Markdown("!first".into()), store)
                .await
                .unwrap();
            let resp = r.save(store).await.unwrap();
            resource_changed_order_opt = resp.resource_new.clone();
        }
        prev_resource = r.clone();
    }

    let resource_changed_order = resource_changed_order_opt.unwrap();

    assert_eq!(res.count, count, "count changed after updating one value");

    q.sort_by = Some(sort_by.into());
    let res = store.query(&q).await.unwrap();
    assert_eq!(
        res.resources[0].get_subject(),
        resource_changed_order.get_subject(),
        "order did not change after updating resource"
    );

    let mut delete_resource = store
        .get_resource(&subject_to_delete.as_str().into())
        .await
        .unwrap();
    delete_resource.destroy(store).await.unwrap();
    let res = store.query(&q).await.unwrap();
    assert!(
        !res.subjects.iter().any(|s| s.as_str() == subject_to_delete),
        "deleted resource still in results"
    );

    q.sort_desc = true;
    let res = store.query(&q).await.unwrap();
    let first = res.resources[0].get(sort_by).unwrap().to_string();
    let later = res.resources[limit - 1].get(sort_by).unwrap().to_string();
    assert!(first > later, "sort by desc");

    // We set the limit to 2 to make sure Query always returns the 1 out of 10 resources that has public rights.
    q.limit = Some(2);
    q.for_agent = urls::PUBLIC_AGENT.into();
    let res = store.query(&q).await.unwrap();
    assert_eq!(res.subjects.len(), 1, "authorized subjects");
    assert_eq!(res.resources.len(), 1, "authorized resources");
    // TODO: Ideally, the count is authorized too. But doing that could be hard. (or expensive)
    // https://github.com/atomicdata-dev/atomic-server/issues/286
    // assert_eq!(res.count, 1, "authorized count");

    println!("Filter by value, property and also Sort");
    q.property = Some(prop_filter.into());
    q.value = Some(demo_reference);
    q.sort_by = Some(sort_by.into());
    q.for_agent = ForAgent::Sudo;
    q.limit = Some(limit);
    let res = store.query(&q).await.unwrap();
    println!("res {:?}", res.subjects);
    let first = res.resources[0].get(sort_by).unwrap().to_string();
    let later = res.resources[limit - 1].get(sort_by).unwrap().to_string();
    assert!(first > later, "sort by desc");

    println!("Set a start value");
    let middle_val = res.resources[limit / 2].get(sort_by).unwrap().to_string();
    q.start_val = Some(Value::String(middle_val.clone()));
    let res = store.query(&q).await.unwrap();
    println!("res {:?}", res.subjects);

    let first = res.resources[0].get(sort_by).unwrap().to_string();
    assert!(
        first > middle_val,
        "start value not respected, found value larger than middle value of earlier query"
    );
}

/// Check if `include_external` is respected.
#[tokio::test]
async fn query_include_external() {
    let store_owned = Db::init_temp("query_include_external").await.unwrap();
    crate::test_utils::setup_test_env(&store_owned).await.unwrap();
    let store = &store_owned;

    let mut q = Query {
        property: Some(urls::DESCRIPTION.into()),
        value: None,
        limit: None,
        start_val: None,
        end_val: None,
        offset: 0,
        sort_by: None,
        sort_desc: false,
        include_external: true,
        include_nested: false,
        for_agent: ForAgent::Sudo,
        drive: None,
    };
    let res_include = store.query(&q).await.unwrap();
    q.include_external = false;
    let res_no_include = store.query(&q).await.unwrap();
    println!("{:?}", res_include.subjects.len());
    println!("{:?}", res_no_include.subjects.len());
    assert!(
        res_include.subjects.len() > res_no_include.subjects.len(),
        "Amount of results should be higher for include_external"
    );
}

#[tokio::test]
async fn resources_all() {
    let store_owned = Db::init_temp("resources_all").await.unwrap();
    crate::test_utils::setup_test_env(&store_owned).await.unwrap();
    let store = &store_owned;
    let res_no_include = store.all_resources(false).count();
    let res_include = store.all_resources(true).count();
    assert!(
        res_include > res_no_include,
        "Amount of results should be higher for include_external"
    );
}

#[tokio::test]
/// Changing these values actually correctly updates the index.
async fn invalidate_cache() {
    let store_owned = Db::init_temp("invalidate_cache").await.unwrap();
    crate::test_utils::setup_test_env(&store_owned).await.unwrap();
    let store = &store_owned;

    // Make sure to use Properties that are not in the default store

    // Do strings work?
    test_collection_update_value(
        store,
        urls::FILENAME,
        Value::String("old_val".into()),
        Value::String("1".into()),
    )
    .await;
    // Do booleans work?
    test_collection_update_value(
        store,
        urls::IS_LOCKED,
        Value::Boolean(true),
        Value::Boolean(false),
    )
    .await;
    // Do ResourceArrays work?
    test_collection_update_value(
        store,
        urls::ATTACHMENTS,
        Value::ResourceArray(vec![
            "http://example.com/1".into(),
            "http://example.com/2".into(),
            "http://example.com/3".into(),
        ]),
        Value::ResourceArray(vec!["http://example.com/1".into()]),
    )
    .await;
}

/// Generates a bunch of resources, changes the value for one of them, checks if the order has changed correctly.
/// new_val should be lexicographically _smaller_ than old_val.
async fn test_collection_update_value(
    store: &Db,
    property_url: &str,
    old_val: Value,
    new_val: Value,
) {
    let irrelevant_property_url = urls::DESCRIPTION;
    let filter_prop = urls::DATATYPE_PROP;
    let filter_val = Value::AtomicUrl(urls::DATATYPE_CLASS.into());
    assert_ne!(
        property_url, irrelevant_property_url,
        "property_url should be different from urls::DESCRIPTION"
    );
    assert_ne!(
        property_url,
        filter_prop.to_string(),
        "property_url should be different from urls::REDIRECT"
    );
    println!("cache_invalidation test for {}", property_url);
    let count = 10;
    let limit = 5;
    assert!(
        count > limit,
        "the following tests might not make sense if count is less than limit"
    );

    let mut resources: Vec<Resource> = futures::future::join_all((0..count).map(async |_num| {
        let mut demo_resource = Resource::new_generate_subject(store).unwrap();
        demo_resource
            .set(property_url.into(), old_val.clone(), store)
            .await
            .unwrap();
        demo_resource
            .set(filter_prop.to_string(), filter_val.clone(), store)
            .await
            .unwrap();
        // We're only using this value to remove it later on
        demo_resource
            .set_string(irrelevant_property_url.into(), "value", store)
            .await
            .unwrap();
        demo_resource.save(store).await.unwrap();
        demo_resource
    }))
    .await;
    assert_eq!(resources.len(), count, "resources created wrong number");

    let q = Query {
        property: Some(filter_prop.into()),
        value: Some(filter_val),
        limit: Some(limit),
        start_val: None,
        end_val: None,
        offset: 0,
        sort_by: Some(property_url.into()),
        sort_desc: false,
        include_external: true,
        include_nested: true,
        for_agent: ForAgent::Sudo,
        drive: Some(Subject::from("internal:/")),
    };
    let mut res = store.query(&q).await.unwrap();
    assert_eq!(
        res.count, count,
        "Not the right amount of members in this collection"
    );

    // For one resource, we will change the order by changing its value
    let mut resource_changed_order_opt = None;
    for (i, r) in res.resources.iter_mut().enumerate() {
        // We change the order!
        if i == 4 {
            r.set(property_url.into(), new_val.clone(), store)
                .await
                .unwrap();
            r.save(store).await.unwrap();
            resource_changed_order_opt = Some(r.clone());
        }
    }

    let resource_changed_order =
        resource_changed_order_opt.expect("not enough resources in collection");

    let res = store.query(&q).await.expect("No first result ");
    assert_eq!(res.count, count, "count changed after updating one value");

    assert_eq!(
        res.subjects.first().unwrap().as_str(),
        resource_changed_order.get_subject().as_str(),
        "Updated resource is not the first Result of the new query"
    );

    // Remove one of the properties, not relevant to the query.
    // This should not impact the results
    resources[1].remove_propval(irrelevant_property_url);
    resources[1].save(store).await.unwrap();
    let res = store
        .query(&q)
        .await
        .expect("No hits found after removing unrelated value");
    assert_eq!(
        res.count, count,
        "count changed after updating irrelevant value"
    );

    // Modify the filtered property.
    // This should remove the item from the results.
    resources[1].remove_propval(filter_prop);
    resources[1].save(store).await.unwrap();
    let res = store
        .query(&q)
        .await
        .expect("No hits found after changing filter value");
    assert_eq!(
        res.count,
        count - 1,
        "Modifying the filtered value did not remove the item from the results"
    );
}

#[tokio::test]
async fn test_migration_v2_to_v3() {
    let tmp_dir_path = ".temp/db/migration_v2_v3";
    let _try_remove_existing = std::fs::remove_dir_all(tmp_dir_path);
    let server_url = "https://localhost";
    let store = Db::init(
        std::path::Path::new(tmp_dir_path),
        Some(server_url.to_string()),
    )
    .await
    .unwrap();

    // Create an old-style PropValsV2
    let mut propvals = crate::db::v2_types::PropValsV2::new();
    let subject_url = format!("{}/test-resource", server_url);
    propvals.insert(
        crate::urls::DESCRIPTION.to_string(),
        crate::db::v2_types::ValueV2::String("test".to_string()),
    );
    // Add an AtomicUrl that points to itself
    propvals.insert(
        crate::urls::PARENT.to_string(),
        crate::db::v2_types::ValueV2::AtomicUrl(subject_url.clone()),
    );

    // Manually insert into resources_v2 using raw sled access
    // Drop the Db first so we can open the sled database directly
    drop(store);
    let sled_store = super::sled_store::SledStore::open(std::path::Path::new(tmp_dir_path)).unwrap();
    {
        let v2_tree = sled_store.raw_db().open_tree("resources_v2").unwrap();
        v2_tree
            .insert(
                subject_url.as_bytes(),
                rmp_serde::to_vec(&propvals).unwrap(),
            )
            .unwrap();
        v2_tree.flush().unwrap();
    }

    // Run migration
    super::migrations::migrate_maybe(&sled_store).unwrap();
    drop(sled_store);

    // Re-open the Db to pick up the migrated data
    let store = crate::Db::init(
        std::path::Path::new(&tmp_dir_path),
        Some(server_url.to_string()),
    )
    .await
    .unwrap();

    // Verify results in v3
    let resource = store
        .get_resource(&subject_url.clone().into())
        .await
        .unwrap();

    // The subject in the resource should now be Local
    assert!(
        matches!(resource.get_subject(), crate::Subject::Internal { .. }),
        "Subject should be Internal, but is {:?}",
        resource.get_subject()
    );

    // The value for PARENT should now be Local
    let parent = resource.get(crate::urls::PARENT).unwrap();
    if let crate::Value::AtomicUrl(s) = parent {
        assert!(
            matches!(s, crate::Subject::Internal { .. }),
            "Value should be Internal, but is {:?}",
            s
        );
    } else {
        panic!("Value should be AtomicUrl, but is {:?}", parent);
    }

    // Verify it is NOT in resources_v2 anymore (it should have been dropped)
    drop(store);
    let sled_store2 = super::sled_store::SledStore::open(std::path::Path::new(tmp_dir_path)).unwrap();
    assert!(!sled_store2
        .raw_db()
        .tree_names()
        .into_iter()
        .any(|n| n == "resources_v2".as_bytes()));
}
