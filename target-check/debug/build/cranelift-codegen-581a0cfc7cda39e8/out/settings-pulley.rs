#[derive(Clone, PartialEq, Hash)] // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:397
/// Flags group `pulley`.
pub struct Flags {
    bytes: [u8; 2], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:400
}
impl Flags {
    /// Create flags pulley settings group.
    #[allow(unused_variables, reason = "generated code")] // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:24
    pub fn new(shared: &settings::Flags, builder: &Builder) -> Self {
        let bvec = builder.state_for("pulley"); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:29
        let mut pulley = Self { bytes: [0; 2] }; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:30
        debug_assert_eq!(bvec.len(), 2); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:36
        pulley.bytes[0..2].copy_from_slice(&bvec); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:41
        pulley // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:48
    }
}
impl Flags {
    /// Iterates the setting values.
    pub fn iter(&self) -> impl Iterator<Item = Value> + use<> {
        let mut bytes = [0; 2]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:58
        bytes.copy_from_slice(&self.bytes[0..2]); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:59
        DESCRIPTORS.iter().filter_map(move |d| {
            let values = match &d.detail {
                detail::Detail::Preset => return None, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:62
                detail::Detail::Enum { last, enumerators } => Some(TEMPLATE.enums(*last, *enumerators)), // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:63
                _ => None // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:64
            }
            ; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:66
            Some(Value { name: d.name, detail: d.detail, values, value: bytes[d.offset as usize] }) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:67
        }
        ) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:69
    }
}
/// Values for `pulley.pointer_width`.
#[derive(Debug, Copy, Clone, PartialEq, Eq, Hash)] // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:131
pub enum PointerWidth {
    /// `pointer32`.
    Pointer32, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:135
    /// `pointer64`.
    Pointer64, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:135
}
impl PointerWidth {
    /// Returns a slice with all possible [PointerWidth] values. // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:76
    pub fn all() -> &'static [PointerWidth] {
        &[ // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:82
            Self::Pointer32, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:85
            Self::Pointer64, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:85
        ] // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:88
    }
}
impl fmt::Display for PointerWidth {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str(match *self {
            Self::Pointer32 => "pointer32", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:100
            Self::Pointer64 => "pointer64", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:100
        }
        ) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:103
    }
}
impl core::str::FromStr for PointerWidth {
    type Err = (); // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:109
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "pointer32" => Ok(Self::Pointer32), // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:113
            "pointer64" => Ok(Self::Pointer64), // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:113
            _ => Err(()), // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:115
        }
    }
}
/// User-defined settings.
#[allow(dead_code, reason = "generated code")] // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:183
impl Flags {
    /// Dynamic numbered predicate getter.
    fn numbered_predicate(&self, p: usize) -> bool {
        self.bytes[1 + p / 8] & (1 << (p % 8)) != 0 // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:188
    }
    /// The width of pointers for this Pulley target
    /// Supported values:
    /// * 'pointer32'
    /// * 'pointer64'
    pub fn pointer_width(&self) -> PointerWidth {
        match self.bytes[0] {
            0 => {
                PointerWidth::Pointer32
            }
            1 => {
                PointerWidth::Pointer64
            }
            _ => {
                panic!("Invalid enum value")
            }
        }
    }
    /// Whether this is a big-endian target
    /// Whether this is a big-endian target
    pub fn big_endian(&self) -> bool {
        self.numbered_predicate(0) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:155
    }
}
static DESCRIPTORS: [detail::Descriptor; 2] = [ // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:224
    detail::Descriptor {
        name: "pointer_width", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:232
        description: "The width of pointers for this Pulley target", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:233
        offset: 0, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:234
        detail: detail::Detail::Enum { last: 1, enumerators: 0 }, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:245
    }
    , // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:259
    detail::Descriptor {
        name: "big_endian", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:232
        description: "Whether this is a big-endian target", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:233
        offset: 1, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:234
        detail: detail::Detail::Bool { bit: 0 }, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:237
    }
    , // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:259
]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:275
static ENUMERATORS: [&str; 2] = [ // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:278
    "pointer32", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:281
    "pointer64", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:281
]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:284
static HASH_TABLE: [u16; 4] = [ // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:294
    0xffff, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:306
    0, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:298
    1, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:298
    0xffff, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:306
]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:310
static PRESETS: [(u8, u8); 0] = [ // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:313
]; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:330
static TEMPLATE: detail::Template = detail::Template {
    name: "pulley", // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:345
    descriptors: &DESCRIPTORS, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:346
    enumerators: &ENUMERATORS, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:347
    hash_table: &HASH_TABLE, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:348
    defaults: &[0x00, 0x00], // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:349
    presets: &PRESETS, // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:350
}
; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:353
/// Create a `settings::Builder` for the pulley settings group.
pub fn builder() -> Builder {
    Builder::new(&TEMPLATE) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:360
}
impl fmt::Display for Flags {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        writeln!(f, "[pulley]")?; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:369
        for d in &DESCRIPTORS {
            if !d.detail.is_preset() {
                write!(f, "{} = ", d.name)?; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:372
                TEMPLATE.format_toml_value(d.detail, self.bytes[d.offset as usize], f)?; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:373
                writeln!(f)?; // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:377
            }
        }
        Ok(()) // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:380
    }
}
impl Flags {
    /// Get the flag values as raw bytes for hashing.
    pub fn hash_key(&self) -> &[u8] {
        &self.bytes // /Users/joep/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/cranelift-codegen-meta-0.132.0/src/gen_settings.rs:390
    }
}
