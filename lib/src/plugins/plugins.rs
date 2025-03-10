use crate::{class_extender::ClassExtender, endpoints::Endpoint};

pub fn default_class_extenders() -> Vec<ClassExtender> {
    vec![
        crate::plugins::collections::build_collection_extender(),
        crate::plugins::invite::build_invite_extender(),
        crate::plugins::chatroom::build_chatroom_extender(),
        crate::plugins::chatroom::build_message_extender(),
    ]
}

pub fn default_endpoints() -> Vec<Endpoint> {
    vec![
        crate::plugins::versioning::version_endpoint(),
        crate::plugins::versioning::all_versions_endpoint(),
        crate::plugins::path::path_endpoint(),
        crate::plugins::search::search_endpoint(),
        crate::plugins::files::upload_endpoint(),
        crate::plugins::files::download_endpoint(),
        crate::plugins::export::export_endpoint(),
        #[cfg(feature = "html")]
        crate::plugins::bookmark::bookmark_endpoint(),
        crate::plugins::importer::import_endpoint(),
        crate::plugins::query::query_endpoint(),
        #[cfg(debug_assertions)]
        crate::plugins::prunetests::prune_tests_endpoint(),
    ]
}
