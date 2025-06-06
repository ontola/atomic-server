use rmp_serde::Serializer;
use serde::Serialize;

use crate::{
    db::{
        plugin_meta::{PluginMeta, PluginMetaKey},
        query_index::QueryFilter,
    },
    errors::AtomicResult,
    resources::PropVals,
};

/// Encode PropVals to a message pack binary format
#[tracing::instrument(level = "trace")]
pub fn encode_propvals(propvals: &PropVals) -> AtomicResult<Vec<u8>> {
    let bin =
        rmp_serde::to_vec(&propvals).map_err(|e| format!("Could not serialize PropVals: {}", e))?;

    Ok(bin)
}

/// Decode PropVals from a message pack binary format
#[tracing::instrument(level = "trace")]
pub fn decode_propvals(bin: &[u8]) -> AtomicResult<PropVals> {
    let propvals: PropVals =
        rmp_serde::from_slice(bin).map_err(|e| format!("Could not deserialize PropVals: {}", e))?;

    Ok(propvals)
}

// Make QueryFilter serializable to message pack
impl super::query_index::QueryFilter {
    #[tracing::instrument(level = "trace")]
    pub fn encode(&self) -> AtomicResult<Vec<u8>> {
        let mut query_filter_bin = Vec::new();
        self.serialize(&mut Serializer::new(&mut query_filter_bin))
            .map_err(|e| format!("Error encoding QueryFilter: {}", e))?;

        Ok(query_filter_bin)
    }

    #[tracing::instrument(level = "trace")]
    pub fn from_bytes(bytes: &[u8]) -> AtomicResult<QueryFilter> {
        let query_filter: QueryFilter = rmp_serde::from_slice(bytes)
            .map_err(|e| format!("Error decoding QueryFilter: {}", e))?;

        Ok(query_filter)
    }
}

impl crate::db::plugin_meta::PluginMeta {
    pub fn encode(&self) -> AtomicResult<Vec<u8>> {
        let mut buf = Vec::new();
        self.serialize(&mut Serializer::new(&mut buf))
            .map_err(|e| format!("Failed to encode PluginMeta: {}", e))?;
        Ok(buf)
    }

    pub fn from_bytes(bytes: &[u8]) -> AtomicResult<PluginMeta> {
        let plugin_meta: PluginMeta = rmp_serde::from_slice(bytes)
            .map_err(|e| format!("Failed to decode PluginMeta: {}", e))?;
        Ok(plugin_meta)
    }
}

impl crate::db::plugin_meta::PluginMetaKey {
    pub fn encode(&self) -> AtomicResult<Vec<u8>> {
        let mut buf = Vec::new();
        self.serialize(&mut Serializer::new(&mut buf))
            .map_err(|e| format!("Failed to encode PluginMetaKey: {}", e))?;
        Ok(buf)
    }

    pub fn from_bytes(bytes: &[u8]) -> AtomicResult<PluginMetaKey> {
        let plugin_meta_key: PluginMetaKey = rmp_serde::from_slice(bytes)
            .map_err(|e| format!("Failed to decode PluginMetaKey: {}", e))?;
        Ok(plugin_meta_key)
    }
}
