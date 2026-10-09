//! Build and runtime gates for the public surfaces a plugin can open on this
//! server: routes, `/.well-known/` claims, inbound writes, listeners and
//! sidecars.
//!
//! Each surface needs all three gates (design: atomic-plugins
//! `docs/design/server-plugin-routes.md`, section 0):
//!
//! 1. **Build**: the `plugin-routes` Cargo feature ([`COMPILED`]). Never part
//!    of `default` or of a release feature set; the tests below enforce that.
//! 2. **Runtime**: `--plugin-routes off|read-only|read-write`
//!    (`ATOMIC_PLUGIN_ROUTES`), default `off`. [`resolve`] turns the options
//!    into a [`PluginRoutesConfig`] once at startup.
//! 3. **Install consent**: the Installation review. Later issues check
//!    [`PluginRoutesConfig::allows`] there.
//!
//! The options exist in every build, so an operator who sets one on a build
//! without the feature gets a startup error instead of a silently ignored
//! variable.

/// Whether this binary was built with the `plugin-routes` feature.
#[cfg(feature = "plugin-routes")]
pub const COMPILED: bool = true;
/// Whether this binary was built with the `plugin-routes` feature.
#[cfg(not(feature = "plugin-routes"))]
pub const COMPILED: bool = false;

/// How much the operator lets installed plugins expose. Ordered: a surface
/// that needs `ReadOnly` is also allowed at `ReadWrite`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, clap::ValueEnum)]
pub enum PluginRoutesLevel {
    /// No gated surface is active, even in a build that has the feature.
    #[default]
    Off,
    /// Anonymous `GET`/`HEAD` routes and well-known claims. No inbound request
    /// can cause a write or an outbound request.
    ReadOnly,
    /// Everything: write routes, host-held keys and tokens, deliveries,
    /// listeners and sidecars.
    ReadWrite,
}

impl PluginRoutesLevel {
    /// The option value, also what clients are told.
    pub fn as_str(self) -> &'static str {
        match self {
            PluginRoutesLevel::Off => "off",
            PluginRoutesLevel::ReadOnly => "read-only",
            PluginRoutesLevel::ReadWrite => "read-write",
        }
    }
}

/// A port the operator binds for a `server-extension` plugin
/// (`ATOMIC_PLUGIN_LISTENERS=willow-wgps:4455`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listener {
    pub name: String,
    pub port: u16,
}

/// A loopback daemon a plugin may call
/// (`ATOMIC_PLUGIN_SIDECARS=pds=http://127.0.0.1:2583`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sidecar {
    pub name: String,
    pub url: url::Url,
}

/// The gates as resolved at startup. Constant while the server runs.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PluginRoutesConfig {
    compiled: bool,
    level: PluginRoutesLevel,
    routes_origin: Option<url::Url>,
    listeners: Vec<Listener>,
    sidecars: Vec<Sidecar>,
}

impl PluginRoutesConfig {
    /// Whether the binary has the build gate.
    pub fn compiled(&self) -> bool {
        self.compiled
    }

    /// The effective level: what the operator asked for, and `Off` whenever
    /// the build gate is closed.
    pub fn level(&self) -> PluginRoutesLevel {
        if self.compiled {
            self.level
        } else {
            PluginRoutesLevel::Off
        }
    }

    /// Whether a surface that needs `needed` may be active on this node.
    /// `Off` means "needs no gate" and is always allowed.
    pub fn allows(&self, needed: PluginRoutesLevel) -> bool {
        needed <= self.level()
    }

    /// The dedicated origin for the `installation-origin` mount. `None`: only
    /// the `drive-prefix` mount is available.
    pub fn routes_origin(&self) -> Option<&url::Url> {
        self.routes_origin.as_ref()
    }

    pub fn listeners(&self) -> &[Listener] {
        &self.listeners
    }

    pub fn sidecars(&self) -> &[Sidecar] {
        &self.sidecars
    }

    /// `hostFeatures.pluginRoutes` for `/plugin-catalog`. Names only: ports
    /// and sidecar URLs are never reported.
    pub fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "compiled": self.compiled,
            "level": self.level().as_str(),
            "routesOrigin": self.routes_origin.as_ref().map(|u| u.origin().ascii_serialization()),
            "listeners": self.listeners.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(),
            "sidecars": self.sidecars.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
        })
    }

    /// What to log once at startup, if anything.
    pub fn startup_notice(&self) -> Option<String> {
        if self.level() == PluginRoutesLevel::Off {
            return None;
        }
        Some(match &self.routes_origin {
            Some(origin) => format!(
                "Plugin routes are on ({}); installation origins are subdomains of {}.",
                self.level().as_str(),
                origin.origin().ascii_serialization()
            ),
            None => format!(
                "Plugin routes are on ({}) without ATOMIC_ROUTES_ORIGIN: only the drive-prefix mount (/_routes/...) is available.",
                self.level().as_str()
            ),
        })
    }
}

/// The raw option values, as `clap` parsed them from flags or env vars.
#[derive(Clone, Copy, Debug, Default)]
pub struct PluginRoutesOptions<'a> {
    pub level: PluginRoutesLevel,
    pub routes_origin: Option<&'a str>,
    pub listeners: Option<&'a str>,
    pub sidecars: Option<&'a str>,
}

/// Where the resolved routes origin must not overlap.
#[derive(Clone, Copy, Debug, Default)]
pub struct OriginContext<'a> {
    /// This server's API origin, e.g. `https://example.com`.
    pub api_origin: &'a str,
    pub base_domain: Option<&'a str>,
    pub website_origin: Option<&'a str>,
}

/// Validates the options against the build gate and each other. `compiled`
/// is [`COMPILED`] outside tests. Every refusal is a startup error.
pub fn resolve(
    options: PluginRoutesOptions,
    compiled: bool,
    origins: OriginContext,
) -> Result<PluginRoutesConfig, String> {
    let routes_origin = set(options.routes_origin);
    let listeners = set(options.listeners);
    let sidecars = set(options.sidecars);

    if !compiled {
        let offending = if options.level != PluginRoutesLevel::Off {
            Some(format!(
                "`--plugin-routes {}` (ATOMIC_PLUGIN_ROUTES)",
                options.level.as_str()
            ))
        } else if listeners.is_some() {
            Some("`--plugin-listeners` (ATOMIC_PLUGIN_LISTENERS)".to_string())
        } else if sidecars.is_some() {
            Some("`--plugin-sidecars` (ATOMIC_PLUGIN_SIDECARS)".to_string())
        } else if routes_origin.is_some() {
            Some("`--routes-origin` (ATOMIC_ROUTES_ORIGIN)".to_string())
        } else {
            None
        };
        return match offending {
            Some(option) => Err(format!(
                "This AtomicServer was built without the `plugin-routes` feature, so {option} has no effect. Rebuild with `--features plugin-routes`, or remove the option."
            )),
            None => Ok(PluginRoutesConfig::default()),
        };
    }

    let listeners = listeners
        .map(parse_listeners)
        .transpose()?
        .unwrap_or_default();
    let sidecars = sidecars
        .map(parse_sidecars)
        .transpose()?
        .unwrap_or_default();
    if options.level < PluginRoutesLevel::ReadWrite {
        let option = if !listeners.is_empty() {
            Some("`--plugin-listeners` (ATOMIC_PLUGIN_LISTENERS)")
        } else if !sidecars.is_empty() {
            Some("`--plugin-sidecars` (ATOMIC_PLUGIN_SIDECARS)")
        } else {
            None
        };
        if let Some(option) = option {
            return Err(format!(
                "{option} needs `--plugin-routes read-write`, but the level is `{}`. Raise the level or remove the option.",
                options.level.as_str()
            ));
        }
    }

    let routes_origin = routes_origin
        .map(|raw| {
            let website_host = origins
                .website_origin
                .and_then(|w| url::Url::parse(w).ok())
                .and_then(|w| w.host_str().map(str::to_string));
            let others: Vec<&str> = origins
                .base_domain
                .into_iter()
                .chain(website_host.as_deref())
                .collect();
            crate::helpers::separate_origin(raw, origins.api_origin, &others).ok_or_else(|| {
                format!(
                    "`--routes-origin` (ATOMIC_ROUTES_ORIGIN) `{raw}` must be a separate HTTPS origin (or http://routes.localhost:PORT in development), outside the API, drive and website domains."
                )
            })
        })
        .transpose()?;

    Ok(PluginRoutesConfig {
        compiled,
        level: options.level,
        routes_origin,
        listeners,
        sidecars,
    })
}

/// An option counts as unset when empty, as an empty env var often is.
fn set(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

/// A listener or sidecar name: what a manifest refers to.
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn entries(raw: &str) -> impl Iterator<Item = &str> {
    raw.split(',').map(str::trim).filter(|e| !e.is_empty())
}

fn refuse_duplicate(seen: &mut Vec<String>, name: &str, option: &str) -> Result<(), String> {
    if seen.iter().any(|n| n == name) {
        return Err(format!("{option}: `{name}` is named twice."));
    }
    seen.push(name.to_string());
    Ok(())
}

/// `name:port,...`
fn parse_listeners(raw: &str) -> Result<Vec<Listener>, String> {
    const OPTION: &str = "ATOMIC_PLUGIN_LISTENERS";
    let mut seen = Vec::new();
    entries(raw)
        .map(|entry| {
            let (name, port) = entry
                .split_once(':')
                .ok_or_else(|| format!("{OPTION}: `{entry}` is not `name:port`."))?;
            let name = name.trim();
            if !valid_name(name) {
                return Err(format!(
                    "{OPTION}: `{name}` is not a name (lowercase letters, digits and `-`)."
                ));
            }
            let port: u16 = port
                .trim()
                .parse()
                .ok()
                .filter(|p| *p != 0)
                .ok_or_else(|| format!("{OPTION}: `{entry}` needs a port from 1 to 65535."))?;
            refuse_duplicate(&mut seen, name, OPTION)?;
            Ok(Listener {
                name: name.to_string(),
                port,
            })
        })
        .collect()
}

/// `name=http://127.0.0.1:port,...`. Sidecars are loopback daemons: any other
/// host would turn the option into an egress-guard bypass.
fn parse_sidecars(raw: &str) -> Result<Vec<Sidecar>, String> {
    const OPTION: &str = "ATOMIC_PLUGIN_SIDECARS";
    let mut seen = Vec::new();
    entries(raw)
        .map(|entry| {
            let (name, url) = entry
                .split_once('=')
                .ok_or_else(|| format!("{OPTION}: `{entry}` is not `name=http://127.0.0.1:port`."))?;
            let name = name.trim();
            if !valid_name(name) {
                return Err(format!(
                    "{OPTION}: `{name}` is not a name (lowercase letters, digits and `-`)."
                ));
            }
            let url = url::Url::parse(url.trim())
                .ok()
                .filter(|u| {
                    let loopback = match u.host() {
                        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                        Some(url::Host::Domain(d)) => d == "localhost",
                        None => false,
                    };
                    matches!(u.scheme(), "http" | "https")
                        && loopback
                        && u.username().is_empty()
                        && u.password().is_none()
                })
                .ok_or_else(|| {
                    format!("{OPTION}: `{name}` must point at a loopback address, like http://127.0.0.1:2583.")
                })?;
            refuse_duplicate(&mut seen, name, OPTION)?;
            Ok(Sidecar {
                name: name.to_string(),
                url,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use PluginRoutesLevel::*;

    const API: OriginContext = OriginContext {
        api_origin: "https://example.com",
        base_domain: None,
        website_origin: Some("https://sites.example.net"),
    };

    fn options(level: PluginRoutesLevel) -> PluginRoutesOptions<'static> {
        PluginRoutesOptions {
            level,
            ..Default::default()
        }
    }

    #[test]
    fn levels_are_ordered() {
        assert!(Off < ReadOnly && ReadOnly < ReadWrite);
    }

    #[test]
    fn nothing_set_is_off_in_either_build() {
        for compiled in [false, true] {
            let config = resolve(options(Off), compiled, API).unwrap();
            assert_eq!(config.level(), Off);
            assert!(config.allows(Off));
            assert!(!config.allows(ReadOnly));
            assert_eq!(config.startup_notice(), None);
        }
    }

    #[test]
    fn a_non_off_level_without_the_feature_refuses_to_start() {
        for level in [ReadOnly, ReadWrite] {
            let err = resolve(options(level), false, API).unwrap_err();
            assert!(
                err.contains("built without the `plugin-routes` feature"),
                "{err}"
            );
            assert!(
                err.contains(&format!("`--plugin-routes {}`", level.as_str())),
                "{err}"
            );
            assert!(err.contains("--features plugin-routes"), "{err}");
        }
    }

    #[test]
    fn listeners_sidecars_or_origin_without_the_feature_refuse_to_start() {
        let cases = [
            (
                PluginRoutesOptions {
                    listeners: Some("x:4455"),
                    ..Default::default()
                },
                "ATOMIC_PLUGIN_LISTENERS",
            ),
            (
                PluginRoutesOptions {
                    sidecars: Some("pds=http://127.0.0.1:2583"),
                    ..Default::default()
                },
                "ATOMIC_PLUGIN_SIDECARS",
            ),
            (
                PluginRoutesOptions {
                    routes_origin: Some("https://routes.example.net"),
                    ..Default::default()
                },
                "ATOMIC_ROUTES_ORIGIN",
            ),
        ];
        for (opts, name) in cases {
            let err = resolve(opts, false, API).unwrap_err();
            assert!(
                err.contains(name) && err.contains("--features plugin-routes"),
                "{err}"
            );
        }
    }

    #[test]
    fn empty_values_count_as_unset() {
        let opts = PluginRoutesOptions {
            level: Off,
            routes_origin: Some(""),
            listeners: Some("  "),
            sidecars: Some(""),
        };
        assert_eq!(resolve(opts, false, API).unwrap().level(), Off);
    }

    #[test]
    fn the_effective_level_follows_the_option_when_compiled() {
        for level in [Off, ReadOnly, ReadWrite] {
            let config = resolve(options(level), true, API).unwrap();
            assert_eq!(config.level(), level);
            assert!(config.compiled());
            assert!(config.allows(level));
            assert_eq!(config.allows(ReadWrite), level == ReadWrite);
        }
    }

    #[test]
    fn the_effective_level_is_off_when_not_compiled() {
        let config = PluginRoutesConfig {
            compiled: false,
            level: ReadWrite,
            ..Default::default()
        };
        assert_eq!(config.level(), Off);
        assert!(!config.allows(ReadOnly));
    }

    #[test]
    fn listeners_and_sidecars_need_read_write() {
        for level in [Off, ReadOnly] {
            let err = resolve(
                PluginRoutesOptions {
                    level,
                    listeners: Some("x:4455"),
                    ..Default::default()
                },
                true,
                API,
            )
            .unwrap_err();
            assert!(
                err.contains("ATOMIC_PLUGIN_LISTENERS") && err.contains("read-write"),
                "{err}"
            );
            let err = resolve(
                PluginRoutesOptions {
                    level,
                    sidecars: Some("pds=http://127.0.0.1:2583"),
                    ..Default::default()
                },
                true,
                API,
            )
            .unwrap_err();
            assert!(err.contains("ATOMIC_PLUGIN_SIDECARS"), "{err}");
        }
    }

    #[test]
    fn listeners_and_sidecars_parse_at_read_write() {
        let config = resolve(
            PluginRoutesOptions {
                level: ReadWrite,
                listeners: Some("willow-wgps:4455, other:8080"),
                sidecars: Some("pds=http://127.0.0.1:2583,ng=http://[::1]:14400"),
                ..Default::default()
            },
            true,
            API,
        )
        .unwrap();
        assert_eq!(
            config.listeners(),
            [
                Listener {
                    name: "willow-wgps".into(),
                    port: 4455
                },
                Listener {
                    name: "other".into(),
                    port: 8080
                }
            ]
        );
        assert_eq!(config.sidecars()[0].name, "pds");
        assert_eq!(config.sidecars()[0].url.as_str(), "http://127.0.0.1:2583/");
        assert_eq!(config.sidecars()[1].name, "ng");
    }

    #[test]
    fn malformed_listeners_and_sidecars_are_refused() {
        let listeners = ["x", "x:0", "x:70000", "X:1", "a b:1", "x:1,x:2", ":1"];
        for raw in listeners {
            let opts = PluginRoutesOptions {
                level: ReadWrite,
                listeners: Some(raw),
                ..Default::default()
            };
            assert!(resolve(opts, true, API).is_err(), "{raw}");
        }
        let sidecars = [
            "pds",
            "pds=not a url",
            "pds=http://example.com:2583",
            "pds=http://10.0.0.1:2583",
            "pds=ftp://127.0.0.1:2583",
            "pds=http://u:p@127.0.0.1:2583",
            "pds=http://127.0.0.1:1,pds=http://127.0.0.1:2",
        ];
        for raw in sidecars {
            let opts = PluginRoutesOptions {
                level: ReadWrite,
                sidecars: Some(raw),
                ..Default::default()
            };
            assert!(resolve(opts, true, API).is_err(), "{raw}");
        }
    }

    #[test]
    fn the_routes_origin_is_validated_like_the_website_origin() {
        let with = |origin: &'static str, ctx: OriginContext<'static>| {
            resolve(
                PluginRoutesOptions {
                    level: ReadOnly,
                    routes_origin: Some(origin),
                    ..Default::default()
                },
                true,
                ctx,
            )
        };
        let ok = with("https://routes.example.net", API).unwrap();
        assert_eq!(
            ok.routes_origin().map(|u| u.as_str()),
            Some("https://routes.example.net/")
        );
        // The API host, a subdomain of it, and the website origin are refused.
        for bad in [
            "https://example.com",
            "https://routes.example.com",
            "https://sites.example.net",
            "https://a.sites.example.net",
            "http://routes.example.net",
            "https://routes.example.net/path",
            "https://u@routes.example.net",
            "not a url",
        ] {
            assert!(with(bad, API).is_err(), "{bad}");
        }
        let base = OriginContext {
            base_domain: Some("atomicserver.eu"),
            ..API
        };
        assert!(with("https://routes.atomicserver.eu", base).is_err());
        // `*.localhost` works in development, next to a localhost API.
        let local = OriginContext {
            api_origin: "http://localhost:9883",
            base_domain: None,
            website_origin: None,
        };
        assert!(with("http://routes.localhost:9883", local).is_ok());
    }

    #[test]
    fn the_report_names_but_never_ports_or_urls() {
        let config = resolve(
            PluginRoutesOptions {
                level: ReadWrite,
                routes_origin: Some("https://routes.example.net"),
                listeners: Some("willow-wgps:4455"),
                sidecars: Some("pds=http://127.0.0.1:2583"),
            },
            true,
            API,
        )
        .unwrap();
        assert_eq!(
            config.report(),
            serde_json::json!({
                "compiled": true,
                "level": "read-write",
                "routesOrigin": "https://routes.example.net",
                "listeners": ["willow-wgps"],
                "sidecars": ["pds"],
            })
        );
        let text = config.report().to_string();
        assert!(!text.contains("4455") && !text.contains("2583"), "{text}");

        assert_eq!(
            PluginRoutesConfig::default().report(),
            serde_json::json!({
                "compiled": false,
                "level": "off",
                "routesOrigin": null,
                "listeners": [],
                "sidecars": [],
            })
        );
    }

    #[test]
    fn an_open_gate_without_a_routes_origin_says_so_once() {
        let config = resolve(options(ReadOnly), true, API).unwrap();
        let notice = config.startup_notice().unwrap();
        assert!(notice.contains("only the drive-prefix mount"), "{notice}");
    }

    #[test]
    fn compiled_matches_the_cargo_feature() {
        assert_eq!(COMPILED, cfg!(feature = "plugin-routes"));
    }

    /// Features in `[features]` of this crate's Cargo.toml, as name -> entries.
    fn cargo_features() -> std::collections::HashMap<String, Vec<String>> {
        let manifest = include_str!("../Cargo.toml");
        let section = manifest
            .split("\n[features]\n")
            .nth(1)
            .expect("Cargo.toml has a [features] section");
        let section = section.split("\n[").next().unwrap();
        let without_comments: String = section
            .lines()
            .map(|l| l.split('#').next().unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        let mut features = std::collections::HashMap::new();
        for decl in without_comments.split(']') {
            let Some((name, list)) = decl.split_once('=') else {
                continue;
            };
            let list = list.trim().trim_start_matches('[');
            let entries = list
                .split(',')
                .map(|e| e.trim().trim_matches('"').to_string())
                .filter(|e| !e.is_empty())
                .collect();
            features.insert(name.trim().to_string(), entries);
        }
        features
    }

    /// Every feature of this crate that `roots` turns on, transitively.
    fn expand(roots: &[&str]) -> std::collections::BTreeSet<String> {
        let features = cargo_features();
        let mut on = std::collections::BTreeSet::new();
        let mut todo: Vec<String> = roots.iter().map(|r| r.to_string()).collect();
        while let Some(f) = todo.pop() {
            if !on.insert(f.clone()) {
                continue;
            }
            for entry in features.get(&f).into_iter().flatten() {
                // `dep:x` and `crate/feature` are not features of this crate.
                if !entry.contains(':') && !entry.contains('/') {
                    todo.push(entry.clone());
                }
            }
        }
        on
    }

    /// The build gate must stay shut on every build that ships. These are the
    /// feature sets `.dagger/src/index.ts` builds releases and CI with, plus
    /// what atomic.place's `managed-node/Cargo.toml` (ontola/atomic-saas)
    /// builds with. `cargo build -p atomic-server` there uses `default` too.
    #[test]
    fn release_feature_sets_exclude_plugin_routes() {
        let features = cargo_features();
        assert!(
            features.contains_key("plugin-routes"),
            "the feature must exist: {:?}",
            features.keys()
        );
        assert!(expand(&["plugin-routes"]).contains("wasm-plugins"));
        let release_sets: &[&[&str]] = &[
            &["default"],
            &["light"],
            &["light", "wasm-plugins"],
            &["https", "wasm-plugins"],
            // atomic.place: default-features = false
            &["https", "telemetry", "img", "wasm-plugins"],
        ];
        for set in release_sets {
            let on = expand(set);
            assert!(
                !on.contains("plugin-routes"),
                "{set:?} turns on plugin-routes: {on:?}"
            );
        }
    }
}
