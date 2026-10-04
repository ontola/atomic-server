//! Explicit replacement and identity-preserving edits for JSON array fields.
use crate::{errors::AtomicResult, schema::app::AppSchema, Resource, Storelike};
use serde_json::Value as Json;

#[derive(Debug, Clone)]
pub enum ListEdit {
    Insert {
        index: usize,
        value: Json,
    },
    Delete {
        index: usize,
    },
    Set {
        index: usize,
        value: Json,
    },
    /// Destination index in the resulting list (not an insertion boundary).
    Move {
        from: usize,
        to: usize,
    },
}
impl ListEdit {
    pub(crate) fn apply(&self, items: &mut Vec<Json>) -> AtomicResult<()> {
        match self {
            Self::Insert { index, value } if *index <= items.len() => {
                items.insert(*index, value.clone())
            }
            Self::Delete { index } if *index < items.len() => {
                items.remove(*index);
            }
            Self::Set { index, value } if *index < items.len() => items[*index] = value.clone(),
            Self::Move { from, to } if *from < items.len() && *to < items.len() => {
                let value = items.remove(*from);
                items.insert(*to, value);
            }
            _ => return Err("List index out of bounds".into()),
        }
        Ok(())
    }
}
impl AppSchema {
    /// Replaces the entire array with a new movable CRDT container. Existing
    /// concurrent edits to the old container do not transfer to this replacement.
    pub async fn replace_list(
        &self,
        resource: &mut Resource,
        field: &str,
        items: Vec<Json>,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        self.encode_field(field, &items)?;
        resource
            .edit_json_list(self.property(field)?, Some(items), None, store)
            .await
    }
    /// Edits an existing movable list, retaining item identity across moves.
    /// Legacy lists require an explicit replace_list; no silent conversion occurs.
    pub async fn edit_list(
        &self,
        resource: &mut Resource,
        field: &str,
        edit: ListEdit,
        store: &impl Storelike,
    ) -> AtomicResult<()> {
        resource
            .edit_json_list(self.property(field)?, None, Some(edit), store)
            .await
    }
}
