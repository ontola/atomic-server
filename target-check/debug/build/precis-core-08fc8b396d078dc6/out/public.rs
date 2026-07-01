// File generated with precis-tools version 0.1.9

use std::cmp::Ord;
use std::cmp::Ordering;
use std::fmt;

/// A representation of either a single codepoint or a range of codepoints.
#[derive(Debug)]
pub enum Codepoints {
    /// A single codepoint.
    Single(u32),
    /// A range of codepoints.
    Range(std::ops::RangeInclusive<u32>),
}

impl fmt::Display for Codepoints {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Codepoints::Single(cp) => write!(f, "single codepoint {:#06x}", cp),
            Codepoints::Range(range) => write!(f, "codepoints range: [{}..{}]",
                range.start(), range.end()),
        }
    }
}

impl PartialEq<std::ops::RangeInclusive<u32>> for Codepoints {
    fn eq(&self, other: &std::ops::RangeInclusive<u32>) -> bool {
        match self {
            Codepoints::Single(ref c) => &(*c..=*c) == other,
            Codepoints::Range(ref r) => r == other,
        }
    }
}

impl PartialEq<Codepoints> for std::ops::RangeInclusive<u32> {
    fn eq(&self, other: &Codepoints) -> bool {
        other.eq(self)
    }
}

impl PartialEq<u32> for Codepoints {
    fn eq(&self, other: &u32) -> bool {
        match self {
            Codepoints::Single(ref c) => c == other,
            Codepoints::Range(ref r) => r.contains(other),
        }
    }
}

impl PartialEq<Codepoints> for u32 {
    fn eq(&self, other: &Codepoints) -> bool {
        other.eq(self)
    }
}

impl PartialEq<(u32, u32)> for Codepoints {
    fn eq(&self, other: &(u32, u32)) -> bool {
        match self {
            Codepoints::Single(ref c) => &(*c, *c) == other,
            Codepoints::Range(ref r) => &(*r.start(), *r.end()) == other,
        }
    }
}

impl PartialEq<Codepoints> for (u32, u32) {
    fn eq(&self, other: &Codepoints) -> bool {
        other.eq(self)
    }
}

impl PartialEq<Codepoints> for Codepoints {
    fn eq(&self, other: &Codepoints) -> bool {
        match self {
            Codepoints::Single(ref c) => other == c,
            Codepoints::Range(ref r) => other == r,
        }
    }
}

impl Eq for Codepoints {}

impl PartialOrd<u32> for Codepoints {
    fn partial_cmp(&self, other: &u32) -> Option<Ordering> {
        if self.lt(other) {
            Some(Ordering::Less)
        } else if self.gt(other) {
            Some(Ordering::Greater)
        } else {
            Some(Ordering::Equal)
        }
    }
    fn lt(&self, other: &u32) -> bool {
        match self {
            Codepoints::Single(ref c) => c < other,
            Codepoints::Range(ref r) => r.end() < other,
        }
    }
    fn le(&self, other: &u32) -> bool {
        match self {
            Codepoints::Single(ref c) => c <= other,
            Codepoints::Range(ref r) => r.start() <= other,
        }
    }
    fn gt(&self, other: &u32) -> bool {
        match self {
            Codepoints::Single(ref c) => c > other,
            Codepoints::Range(ref r) => r.start() > other,
        }
    }
    fn ge(&self, other: &u32) -> bool {
        match self {
            Codepoints::Single(ref c) => c >= other,
            Codepoints::Range(ref r) => r.end() >= other,
        }
    }
}

impl PartialOrd<Codepoints> for u32 {
    fn partial_cmp(&self, other: &Codepoints) -> Option<Ordering> {
        match other {
            Codepoints::Single(ref c) => Some(self.cmp(c)),
            Codepoints::Range(ref r) => {
                if self < r.start() {
                    Some(Ordering::Less)
                } else if self > r.end() {
                    Some(Ordering::Greater)
                } else {
                    Some(Ordering::Equal)
                }
            }
        }
    }

    fn lt(&self, other: &Codepoints) -> bool {
        match other {
            Codepoints::Single(ref c) => self < c,
            Codepoints::Range(ref r) => self < r.start(),
        }
    }
    fn le(&self, other: &Codepoints) -> bool {
        match other {
            Codepoints::Single(ref c) => self <= c,
            Codepoints::Range(ref r) => self <= r.end(),
        }
    }
    fn gt(&self, other: &Codepoints) -> bool {
        match other {
            Codepoints::Single(ref c) => self > c,
            Codepoints::Range(ref r) => self > r.end(),
        }
    }
    fn ge(&self, other: &Codepoints) -> bool {
        match other {
            Codepoints::Single(ref c) => self >= c,
            Codepoints::Range(ref r) => self >= r.start(),
        }
    }
}


/// Derived property value
/// # Notes
/// * **SpecClassPVal** maps to those code points that are allowed
///   to be used in specific string classes such as [`IdentifierClass`]
///   and [`FreeformClass`]. PRECIS framework defines two allowed
///   values for above classes (ID_PVAL adn FREE_PVAL). In practice,
///   the derived property ID_PVAL is not used in this specification,
///   because every ID_PVAL code point is PVALID, so only FREE_PVAL
///   is actually mapped to SpecClassPVal.
/// * **SpecClassDis** maps to those code points that are not to be
///   included in one of the string classes but that might be permitted
///   in others. PRECIS framework defines "FREE_DIS" for the
///   [`FreeformClass`] and "ID_DIS" for the [`IdentifierClass`].
///   In practice, the derived property FREE_DIS is not used in this
///   specification, because every FREE_DIS code point is DISALLOWED,
///   so only ID_DIS is mapped to SpecClassDis.
///   Both SpecClassPVal and SpecClassDis values are used to ease
///   extension if more classes are added beyond [`IdentifierClass`]
///   and [`FreeformClass`] in the future.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DerivedPropertyValue {
	/// Value assigned to all those code points that are allowed to be used in any PRECIS string class.
	PValid,
	/// Value assigned to all those code points that are allowed to be used in an specific PRECIS string class.
	SpecClassPval,
	/// Value assigned to all those code points that are disallowed by a specific PRECIS string class.
	SpecClassDis,
	/// Contextual rule required for Join_controls Unicode codepoints.
	ContextJ,
	/// Contextual rule required for Others Unicode codepoints.
	ContextO,
	/// Those code points that are not permitted in any PRECIS string class.
	Disallowed,
	/// Those code points that are not designated in the Unicode Standard.
	Unassigned,
}

impl std::fmt::Display for DerivedPropertyValue {
	fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
		match self {
			DerivedPropertyValue::PValid => writeln!(f, "PValid"),
			DerivedPropertyValue::SpecClassPval => writeln!(f, "SpecClassPval"),
			DerivedPropertyValue::SpecClassDis => writeln!(f, "SpecClassDis"),
			DerivedPropertyValue::ContextJ => writeln!(f, "ContextJ"),
			DerivedPropertyValue::ContextO => writeln!(f, "ContextO"),
			DerivedPropertyValue::Disallowed => writeln!(f, "Disallowed"),
			DerivedPropertyValue::Unassigned => writeln!(f, "Unassigned"),
		}
	}
}

/// The [Unicode version](http://www.unicode.org/versions) of data
pub const UNICODE_VERSION: (u8, u8, u8) = (6, 3, 0);

