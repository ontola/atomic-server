use atomic_lib::urls;
use pyo3::prelude::*;
use pyo3::types::PyModule;

/// Well-known Atomic Data class and property URLs.
pub(crate) fn urls_module(py: Python<'_>) -> PyResult<Bound<'_, PyModule>> {
    let m = PyModule::new(py, "urls")?;

    // Classes
    m.add("CLASS", urls::CLASS)?;
    m.add("PROPERTY", urls::PROPERTY)?;
    m.add("AGENT", urls::AGENT)?;
    m.add("DRIVE", urls::DRIVE)?;
    m.add("FOLDER", urls::FOLDER)?;
    m.add("FILE", urls::FILE)?;
    m.add("COMMIT", urls::COMMIT)?;
    m.add("CHATROOM", urls::CHATROOM)?;
    m.add("MESSAGE", urls::MESSAGE)?;
    m.add("DOCUMENT_V2", urls::DOCUMENT_V2)?;
    m.add("TABLE", urls::TABLE)?;
    m.add("TAG", urls::TAG)?;
    m.add("PLAIN_TEXT", urls::PLAIN_TEXT)?;
    m.add("FORK", urls::FORK)?;
    m.add("ONTOLOGY", urls::ONTOLOGY)?;
    m.add("BOOKMARK", urls::BOOKMARK)?;

    // Properties
    m.add("NAME", urls::NAME)?;
    m.add("DESCRIPTION", urls::DESCRIPTION)?;
    m.add("SHORTNAME", urls::SHORTNAME)?;
    m.add("IS_A", urls::IS_A)?;
    m.add("PARENT", urls::PARENT)?;
    m.add("READ", urls::READ)?;
    m.add("WRITE", urls::WRITE)?;
    m.add("CHILDREN", urls::CHILDREN)?;
    m.add("DRIVES", urls::DRIVES)?;
    m.add("DATATYPE", urls::DATATYPE_PROP)?;
    m.add("CLASSTYPE", urls::CLASSTYPE_PROP)?;
    m.add("REQUIRES", urls::REQUIRES)?;
    m.add("RECOMMENDS", urls::RECOMMENDS)?;
    m.add("CREATED_AT", urls::CREATED_AT)?;
    m.add("CREATED_BY", urls::CREATED_BY)?;
    m.add("PUBLIC_KEY", urls::PUBLIC_KEY)?;
    m.add("SUBJECT", urls::SUBJECT)?;
    m.add("SIGNER", urls::SIGNER)?;
    m.add("DRIVE_PROP", urls::DRIVE_PROP)?;
    m.add("PERSONAL_DRIVE", urls::PERSONAL_DRIVE)?;
    m.add("LANGUAGE", urls::LANGUAGE)?;

    Ok(m)
}
