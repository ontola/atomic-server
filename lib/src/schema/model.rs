//! Presence-aware fields for generated serde models.
use serde::{Deserialize, Deserializer, Serialize, Serializer};
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Optional<T> {
    #[default]
    Missing,
    Present(T),
}
impl<T> Optional<T> {
    pub fn is_missing(&self) -> bool {
        matches!(self, Self::Missing)
    }
}
impl<T: Serialize> Serialize for Optional<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Present(v) => v.serialize(serializer),
            Self::Missing => Err(serde::ser::Error::custom("Missing field must be omitted")),
        }
    }
}
impl<'de, T: Deserialize<'de>> Deserialize<'de> for Optional<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        T::deserialize(deserializer).map(Self::Present)
    }
}
