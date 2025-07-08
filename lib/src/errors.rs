/*!
Mostly contains implementations for Error types.

The [AtomicError] type should be returned from any function that may fail, although it is not returned everywhere at this moment.
*/

use std::convert::Infallible;

use crate::{urls, Resource, Value};

/// The default Error type for all Atomic Lib Errors.
pub type AtomicResult<T> = std::result::Result<T, AtomicError>;

#[derive(Debug)]
pub struct AtomicError {
    /** Relatively short description of what went wrong and how it can be fixed */
    pub message: String,
    pub error_type: AtomicErrorType,
    pub subject: Option<String>,
    /** Previous error. Note that this can be recursive. */
    pub source: Option<Box<dyn std::error::Error + Send + Sync>>,
    pub backtrace: Option<std::backtrace::Backtrace>,
}

#[derive(Debug, Clone)]
pub enum AtomicErrorType {
    /** HTTP 404 */
    NotFoundError,
    /** HTTP 401 */
    UnauthorizedError,
    /** HTTP 400 */
    ParseError,
    /** HTTP 500 */
    OtherError,
    /** HTTP 405 */
    MethodNotAllowed,
}

impl std::error::Error for AtomicError {
    fn description(&self) -> &str {
        &self.message
    }
}

impl AtomicError {
    /// Create an AtomicError from any error type.
    pub fn from_any<E>(e: E) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        AtomicError {
            message: e.to_string(),
            error_type: AtomicErrorType::OtherError,
            subject: None,
            source: Some(Box::new(e)),
            backtrace: Some(std::backtrace::Backtrace::capture()),
        }
    }

    pub fn with_message<E>(e: E, message: &str) -> Self
    where
        E: std::error::Error + Send + Sync + 'static,
    {
        AtomicError {
            message: message.into(),
            error_type: AtomicErrorType::OtherError,
            subject: None,
            source: Some(Box::new(e)),
            backtrace: Some(std::backtrace::Backtrace::capture()),
        }
    }

    pub fn method_not_allowed(message: &str) -> AtomicError {
        AtomicError {
            message: message.into(),
            error_type: AtomicErrorType::MethodNotAllowed,
            subject: None,
            source: None,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }

    pub fn from_boxed_error(e: Box<dyn std::error::Error + Send + Sync>) -> Self {
        Self {
            message: e.to_string(),
            error_type: AtomicErrorType::OtherError,
            subject: None,
            source: Some(e),
            backtrace: Some(std::backtrace::Backtrace::capture()),
        }
    }

    pub fn from_msg(msg: impl Into<String>) -> Self {
        Self {
            message: msg.into(),
            error_type: AtomicErrorType::OtherError,
            subject: None,
            source: None,
            backtrace: Some(std::backtrace::Backtrace::capture()),
        }
    }

    #[allow(dead_code)]
    /// A server will probably return this errors as a 404.
    pub fn not_found(message: Option<String>, subject: &str) -> AtomicError {
        AtomicError {
            message: message.unwrap_or_else(|| format!("Resource not found: {}", subject)),
            error_type: AtomicErrorType::NotFoundError,
            subject: Some(subject.to_string()),
            source: None,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }

    /// A server will probably return this error as a 403.
    pub fn unauthorized(message: String) -> AtomicError {
        AtomicError {
            message: format!("Unauthorized. {}", message),
            error_type: AtomicErrorType::UnauthorizedError,
            subject: None,
            source: None,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }

    /// A server will probably return this error as a 500.
    pub fn other_error(message: String) -> AtomicError {
        AtomicError {
            message,
            error_type: AtomicErrorType::OtherError,
            subject: None,
            source: None,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }

    pub fn parse_error(
        message: &str,
        subject: Option<&str>,
        property: Option<&str>,
    ) -> AtomicError {
        use std::fmt::Write;
        let mut msg = "Error parsing JSON-AD ".to_string();
        if let Some(prop) = property {
            let _ = write!(msg, "with property {prop} ");
        }
        if let Some(subject) = subject {
            let _ = write!(msg, "of subject {subject} ");
        }
        // remove last space
        msg.pop();
        msg.push_str(". ");
        msg.push_str(message);

        AtomicError {
            message: msg,
            subject: subject.map(|s| s.to_string()),
            source: None,
            error_type: AtomicErrorType::ParseError,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }

    /// Converts the Error into a Resource. This helps clients to handle errors, such as show error messages in the right Form input fields.
    pub fn into_resource(self, subject: String) -> Resource {
        let mut r = Resource::new(subject);
        r.set_class(urls::ERROR);
        r.set_unsafe(urls::DESCRIPTION.into(), Value::String(self.message));
        r
    }

    pub fn set_subject(mut self, subject: &str) -> Self {
        self.subject = Some(subject.into());
        self
    }
}

impl std::fmt::Display for AtomicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "\n{}", self.message)?;

        if let Some(source) = &self.source {
            writeln!(f, "Caused by: {}", source)?;
        }

        if let Some(backtrace) = &self.backtrace {
            writeln!(f, "Backtrace:\n{}", backtrace)?;
        }

        Ok(())
    }
}

impl AtomicError {}

impl From<String> for AtomicError {
    fn from(message: String) -> Self {
        AtomicError {
            message,
            subject: None,
            source: None,
            error_type: AtomicErrorType::OtherError,
            backtrace: Some(std::backtrace::Backtrace::capture()), // optional
        }
    }
}

impl From<&str> for AtomicError {
    fn from(message: &str) -> Self {
        AtomicError::from(message.to_string())
    }
}

macro_rules! impl_from_atomic_error {
    ($($ty:ty),* $(,)?) => {
        $(
            impl From<$ty> for AtomicError {
                fn from(e: $ty) -> Self {
                    AtomicError::from_any(e)
                }
            }
        )*
    };
}

impl_from_atomic_error!(
    std::io::Error,
    std::string::FromUtf8Error,
    std::num::ParseFloatError,
    std::num::ParseIntError,
    std::str::ParseBoolError,
    base64::DecodeError,
    bincode::ErrorKind,
    sled::Error,
    serde_json::Error,
    url::ParseError,
    Infallible,
);

// ## Manual exceptions
// Some errors can't be macro'd

// Boxed errors
impl From<Box<dyn std::error::Error + Send + Sync + 'static>> for AtomicError {
    fn from(e: Box<dyn std::error::Error + Send + Sync + 'static>) -> Self {
        AtomicError::from_boxed_error(e)
    }
}

impl From<Box<bincode::ErrorKind>> for AtomicError {
    fn from(e: Box<bincode::ErrorKind>) -> Self {
        AtomicError::from_boxed_error(e)
    }
}

// PoisonError isn't send + sync
impl<T> From<std::sync::PoisonError<T>> for AtomicError {
    fn from(e: std::sync::PoisonError<T>) -> Self {
        AtomicError::from_msg(e.to_string())
    }
}
