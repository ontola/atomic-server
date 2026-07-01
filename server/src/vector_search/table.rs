use crate::errors::AtomicServerResult;
use arrow::array::RecordBatchIterator;
use arrow::datatypes::{DataType, Field, Schema};
use lancedb::Connection;
use lancedb::Table;
use std::sync::Arc;

pub(crate) fn vector_schema(embedding_dim: usize) -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("subject", DataType::Utf8, false),
        Field::new("text_chunk", DataType::Utf8, false),
        Field::new(
            "is_a",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            true,
        ),
        Field::new(
            "hierarchy",
            DataType::List(Arc::new(Field::new("item", DataType::Utf8, true))),
            true,
        ),
        Field::new(
            "vector",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                embedding_dim as i32,
            ),
            false,
        ),
    ]))
}

pub(crate) fn parse_vector_dimension(schema: &Schema) -> AtomicServerResult<usize> {
    for field in schema.fields() {
        if field.name().as_str() == "vector" {
            return match field.data_type() {
                DataType::FixedSizeList(_, size) => Ok(*size as usize),
                _ => Err("vector column has unexpected Arrow type".into()),
            };
        }
    }
    Err("vector column missing from LanceDB schema".into())
}

pub(crate) async fn table_vector_dimension(table: &Table) -> AtomicServerResult<usize> {
    let schema = table
        .schema()
        .await
        .map_err(|e| format!("Failed to read LanceDB table schema: {}", e))?;
    parse_vector_dimension(&schema)
}

pub(crate) async fn open_resources_table(db: &Connection) -> AtomicServerResult<Table> {
    db.open_table("resources")
        .execute()
        .await
        .map_err(|e| format!("Failed to open lancedb table: {}", e).into())
}

pub(crate) async fn create_resources_table(
    db: &Connection,
    embedding_dim: usize,
) -> AtomicServerResult<Table> {
    let schema = vector_schema(embedding_dim);
    let empty_batches = RecordBatchIterator::new(vec![], schema.clone());
    db.create_table("resources", Box::new(empty_batches))
        .execute()
        .await
        .map_err(|e| format!("Failed to create lancedb table: {}", e).into())
}
