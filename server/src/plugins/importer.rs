/*!
Importers allow users to (periodically) import JSON-AD files from a remote source.
*/

use atomic_lib::{
    agents::ForAgent,
    client,
    endpoints::{BoxFuture, Endpoint, HandleGetContext, HandlePostContext},
    errors::AtomicResult,
    parse,
    storelike::ResourceResponse,
    urls, Storelike,
};

pub fn import_endpoint() -> Endpoint {
    Endpoint {
        path: "/import".to_string(),
        params: [
            urls::IMPORTER_OVERWRITE_OUTSIDE.to_string(),
            urls::IMPORTER_PARENT.to_string(),
            urls::IMPORTER_URL.to_string(),
        ].into(),
        description: "Imports one or more Resources to some parent. POST your JSON-AD and add a `parent` query param to the URL. See https://docs.atomicdata.dev/create-json-ad.html".to_string(),
        shortname: "path".to_string(),
        // Not sure if we need this, or if we should derive it from `None` here.
        handle: None,
        handle_post: Some(handle_post),
    }
}

pub fn handle_get<'a>(
    context: HandleGetContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        import_endpoint()
            .to_resource_response(context.store, context.subject.as_str())
            .await
    })
}

/// When an importer is shown, we list a bunch of Parameters and a list of previously imported items.
#[tracing::instrument]
pub fn handle_post<'a>(
    context: HandlePostContext<'a>,
) -> BoxFuture<'a, AtomicResult<ResourceResponse>> {
    Box::pin(async move {
        let HandlePostContext {
            store,
            body,
            for_agent,
            ref subject,
        } = context;
        let mut url = None;
        let mut json = None;
        let mut parent_maybe = None;
        let mut overwrite_outside = false;
        for (k, v) in subject.query_pairs() {
            match k.as_ref() {
                "json" | urls::IMPORTER_URL => return Err("JSON must be POSTed in the body".into()),
                "url" | urls::IMPORTER_JSON => url = Some(v.to_string()),
                "parent" | urls::IMPORTER_PARENT => parent_maybe = Some(v.to_string()),
                "overwrite-outside" | urls::IMPORTER_OVERWRITE_OUTSIDE => {
                    overwrite_outside = v == "true"
                }
                _ => {}
            }
        }

        let parent = parent_maybe.ok_or("No parent specified for importer")?;

        if !body.is_empty() {
            json = Some(String::from_utf8(body).map_err(|e| {
                format!("Error while decoding body, expected a JSON string: {}", e)
            })?);
        }

        if let Some(fetch_url) = url {
            json = Some(
                client::fetch_body(&fetch_url, parse::JSON_AD_MIME, None)
                    .await
                    .map_err(|e| format!("Error while fetching {}: {}", fetch_url, e))?,
            );
        }

        let parse_opts = parse::ParseOpts {
            for_agent: for_agent.clone(),
            importer: Some(atomic_lib::Subject::from_raw(&parent, None)),
            overwrite_outside,
            // We sign the importer Commits with the default agent,
            // not the one performing the import, because we don't have their private key.
            signer: Some(store.get_default_agent()?),
            save: parse::SaveOpts::Commit,
            ..Default::default()
        };

        if let Some(json_string) = json {
            if for_agent == &ForAgent::Public {
                return Err("No agent specified for importer".to_string().into());
            }
            store.import(&json_string, &parse_opts).await?;
        } else {
            return Err(
                "No JSON specified for importer. Pass a `url` query param, or post a JSON-AD body."
                    .to_string()
                    .into(),
            );
        }

        import_endpoint()
            .to_resource_response(context.store, context.subject.as_str())
            .await
    })
}
