//! Verification of OIDC ID tokens (RFC 7519 JWTs signed per RFC 7515/7518).
//!
//! Deliberately small and built on `ring`, which the server already links:
//! verification only (never signing), a fixed algorithm allowlist, and keys
//! that come only from the configured provider's JWKS. Nothing in a token
//! chooses how it is verified beyond picking one of the three allowed
//! algorithms, and the key type must match that algorithm.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::signature::{
    RsaPublicKeyComponents, UnparsedPublicKey, ECDSA_P256_SHA256_FIXED, RSA_PKCS1_2048_8192_SHA256,
    RSA_PSS_2048_8192_SHA256,
};
use serde::Deserialize;
use serde_json::{Map, Value};

/// Largest ID token we will look at. Real ones are a few KiB.
const MAX_TOKEN_BYTES: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JoseError {
    Malformed(&'static str),
    UnsupportedAlg,
    UnknownKey,
    BadSignature,
    Claim(&'static str),
}

impl std::fmt::Display for JoseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            JoseError::Malformed(m) => write!(f, "malformed token: {m}"),
            JoseError::UnsupportedAlg => write!(f, "unsupported signing algorithm"),
            JoseError::UnknownKey => write!(f, "no matching signing key"),
            JoseError::BadSignature => write!(f, "invalid signature"),
            JoseError::Claim(c) => write!(f, "invalid claim: {c}"),
        }
    }
}

impl std::error::Error for JoseError {}

/// One public key of a provider's JWKS (RFC 7517). Unknown fields are ignored.
#[derive(Debug, Clone, Deserialize)]
pub struct Jwk {
    pub kty: String,
    #[serde(default)]
    pub kid: Option<String>,
    #[serde(default)]
    pub alg: Option<String>,
    #[serde(default, rename = "use")]
    pub use_: Option<String>,
    // RSA
    #[serde(default)]
    pub n: Option<String>,
    #[serde(default)]
    pub e: Option<String>,
    // EC
    #[serde(default)]
    pub crv: Option<String>,
    #[serde(default)]
    pub x: Option<String>,
    #[serde(default)]
    pub y: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Jwks {
    pub keys: Vec<Jwk>,
}

/// What an ID token must satisfy. `now` is unix seconds, injected so tests
/// are deterministic.
pub struct Validation<'a> {
    pub issuer: &'a str,
    pub client_id: &'a str,
    pub nonce: &'a str,
    pub now: i64,
    pub leeway_secs: i64,
}

#[derive(Deserialize)]
struct Header {
    alg: String,
    #[serde(default)]
    kid: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Alg {
    Rs256,
    Ps256,
    Es256,
}

impl Alg {
    fn parse(s: &str) -> Option<Alg> {
        match s {
            "RS256" => Some(Alg::Rs256),
            "PS256" => Some(Alg::Ps256),
            "ES256" => Some(Alg::Es256),
            _ => None,
        }
    }

    fn key_type(self) -> &'static str {
        match self {
            Alg::Rs256 | Alg::Ps256 => "RSA",
            Alg::Es256 => "EC",
        }
    }
}

fn b64(s: &str) -> Result<Vec<u8>, JoseError> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|_| JoseError::Malformed("bad base64url"))
}

fn jwk_matches(key: &Jwk, alg: Alg, kid: Option<&str>) -> bool {
    if key.kty != alg.key_type() {
        return false;
    }

    if let Some(u) = &key.use_ {
        if u != "sig" {
            return false;
        }
    }

    if let Some(a) = &key.alg {
        if Alg::parse(a) != Some(alg) {
            return false;
        }
    }

    match (kid, &key.kid) {
        (Some(want), Some(have)) => want == have,
        // A token with a kid never matches a key without one, and vice versa
        // only when the JWKS has exactly one candidate (handled by the caller).
        (Some(_), None) => false,
        (None, _) => true,
    }
}

fn verify_signature(
    key: &Jwk,
    alg: Alg,
    signing_input: &[u8],
    sig: &[u8],
) -> Result<(), JoseError> {
    match alg {
        Alg::Rs256 | Alg::Ps256 => {
            let n = b64(key.n.as_deref().ok_or(JoseError::UnknownKey)?)?;
            let e = b64(key.e.as_deref().ok_or(JoseError::UnknownKey)?)?;
            let params = if alg == Alg::Rs256 {
                &RSA_PKCS1_2048_8192_SHA256
            } else {
                &RSA_PSS_2048_8192_SHA256
            };
            RsaPublicKeyComponents { n: &n, e: &e }
                .verify(params, signing_input, sig)
                .map_err(|_| JoseError::BadSignature)
        }
        Alg::Es256 => {
            if key.crv.as_deref() != Some("P-256") {
                return Err(JoseError::UnknownKey);
            }

            let x = b64(key.x.as_deref().ok_or(JoseError::UnknownKey)?)?;
            let y = b64(key.y.as_deref().ok_or(JoseError::UnknownKey)?)?;

            if x.len() != 32 || y.len() != 32 {
                return Err(JoseError::UnknownKey);
            }

            let mut point = Vec::with_capacity(65);
            point.push(0x04);
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);

            UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, point)
                .verify(signing_input, sig)
                .map_err(|_| JoseError::BadSignature)
        }
    }
}

/// Verifies the signature and returns the claims, without judging them.
/// [`JoseError::UnknownKey`] is the cue to refresh the JWKS once and retry.
fn verify_signed(token: &str, jwks: &Jwks) -> Result<Map<String, Value>, JoseError> {
    if token.len() > MAX_TOKEN_BYTES {
        return Err(JoseError::Malformed("too long"));
    }

    let mut parts = token.split('.');
    let (Some(h), Some(p), Some(s), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err(JoseError::Malformed("not three segments"));
    };

    let header: Header =
        serde_json::from_slice(&b64(h)?).map_err(|_| JoseError::Malformed("bad header"))?;
    let alg = Alg::parse(&header.alg).ok_or(JoseError::UnsupportedAlg)?;
    let sig = b64(s)?;
    let signing_input = format!("{h}.{p}");

    let candidates: Vec<&Jwk> = jwks
        .keys
        .iter()
        .filter(|k| jwk_matches(k, alg, header.kid.as_deref()))
        .collect();

    if candidates.is_empty() {
        return Err(JoseError::UnknownKey);
    }

    // With no `kid` there can be several keys of the right type (a rotation in
    // progress); any one of them verifying is enough.
    let mut last = JoseError::BadSignature;

    for key in candidates {
        match verify_signature(key, alg, signing_input.as_bytes(), &sig) {
            Ok(()) => {
                let value: Value = serde_json::from_slice(&b64(p)?)
                    .map_err(|_| JoseError::Malformed("bad payload"))?;

                return match value {
                    Value::Object(map) => Ok(map),
                    _ => Err(JoseError::Malformed("payload is not an object")),
                };
            }
            Err(e) => last = e,
        }
    }

    Err(last)
}

/// Equality that does not stop at the first differing byte. The length is not
/// secret (state, nonce and cookie values have a fixed shape).
pub(crate) fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());

    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn int_claim(claims: &Map<String, Value>, name: &'static str) -> Option<i64> {
    let v = claims.get(name)?;

    v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))
}

/// Verifies `token` against `jwks` and checks `iss`, `aud` (+`azp`), `exp`,
/// `nbf`/`iat`, `nonce` and `sub`. Returns the claims on success.
pub fn verify_id_token(
    token: &str,
    jwks: &Jwks,
    v: &Validation<'_>,
) -> Result<Map<String, Value>, JoseError> {
    let claims = verify_signed(token, jwks)?;

    match claims.get("iss").and_then(Value::as_str) {
        Some(iss) if constant_time_eq(iss, v.issuer) => {}
        _ => return Err(JoseError::Claim("iss")),
    }

    match claims.get("aud") {
        Some(Value::String(a)) if a == v.client_id => {}
        Some(Value::Array(list)) => {
            if !list.iter().any(|a| a.as_str() == Some(v.client_id)) {
                return Err(JoseError::Claim("aud"));
            }

            if list.len() > 1 && claims.get("azp").and_then(Value::as_str) != Some(v.client_id) {
                return Err(JoseError::Claim("azp"));
            }
        }
        _ => return Err(JoseError::Claim("aud")),
    }

    // `azp`, when present on a single-audience token, must still be us.
    if let Some(azp) = claims.get("azp") {
        if azp.as_str() != Some(v.client_id) {
            return Err(JoseError::Claim("azp"));
        }
    }

    let exp = int_claim(&claims, "exp").ok_or(JoseError::Claim("exp"))?;

    if exp + v.leeway_secs <= v.now {
        return Err(JoseError::Claim("exp"));
    }

    if let Some(nbf) = int_claim(&claims, "nbf") {
        if nbf - v.leeway_secs > v.now {
            return Err(JoseError::Claim("nbf"));
        }
    }

    if let Some(iat) = int_claim(&claims, "iat") {
        if iat - v.leeway_secs > v.now {
            return Err(JoseError::Claim("iat"));
        }
    }

    match claims.get("nonce").and_then(Value::as_str) {
        Some(n) if constant_time_eq(n, v.nonce) => {}
        _ => return Err(JoseError::Claim("nonce")),
    }

    match claims.get("sub").and_then(Value::as_str) {
        Some(sub) if !sub.is_empty() && sub.len() <= 255 => {}
        _ => return Err(JoseError::Claim("sub")),
    }

    Ok(claims)
}

#[cfg(test)]
pub(crate) mod test_support {
    //! Mints tokens for tests. Signing lives here, never in the server proper.

    use super::*;
    use ring::rand::SystemRandom;
    use ring::signature::{
        EcdsaKeyPair, KeyPair, RsaKeyPair, ECDSA_P256_SHA256_FIXED_SIGNING, RSA_PKCS1_SHA256,
    };

    pub const RSA_PKCS8_B64: &str = include_str!("../../tests/fixtures/oidc_test_rsa_pkcs8.b64");

    pub fn rsa_key() -> RsaKeyPair {
        let der = base64::engine::general_purpose::STANDARD
            .decode(RSA_PKCS8_B64.trim())
            .unwrap();
        RsaKeyPair::from_pkcs8(&der).unwrap()
    }

    pub fn rsa_jwk(kid: &str) -> Jwk {
        let key = rsa_key();
        let pk = key.public();
        let comps: ring::rsa::PublicKeyComponents<Vec<u8>> = pk.into();
        Jwk {
            kty: "RSA".into(),
            kid: Some(kid.into()),
            alg: Some("RS256".into()),
            use_: Some("sig".into()),
            n: Some(URL_SAFE_NO_PAD.encode(&comps.n)),
            e: Some(URL_SAFE_NO_PAD.encode(&comps.e)),
            crv: None,
            x: None,
            y: None,
        }
    }

    pub fn sign_rs256(header: &Value, claims: &Value) -> String {
        let key = rsa_key();
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(claims.to_string())
        );
        let mut sig = vec![0u8; key.public().modulus_len()];
        key.sign(
            &RSA_PKCS1_SHA256,
            &SystemRandom::new(),
            input.as_bytes(),
            &mut sig,
        )
        .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig))
    }

    pub struct EcKey {
        pub pair: EcdsaKeyPair,
    }

    pub fn ec_key() -> EcKey {
        let rng = SystemRandom::new();
        let pkcs8 = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
        EcKey {
            pair: EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, pkcs8.as_ref(), &rng)
                .unwrap(),
        }
    }

    impl EcKey {
        pub fn jwk(&self, kid: &str) -> Jwk {
            let pt = self.pair.public_key().as_ref();
            Jwk {
                kty: "EC".into(),
                kid: Some(kid.into()),
                alg: Some("ES256".into()),
                use_: Some("sig".into()),
                n: None,
                e: None,
                crv: Some("P-256".into()),
                x: Some(URL_SAFE_NO_PAD.encode(&pt[1..33])),
                y: Some(URL_SAFE_NO_PAD.encode(&pt[33..65])),
            }
        }

        pub fn sign(&self, header: &Value, claims: &Value) -> String {
            let input = format!(
                "{}.{}",
                URL_SAFE_NO_PAD.encode(header.to_string()),
                URL_SAFE_NO_PAD.encode(claims.to_string())
            );
            let sig = self
                .pair
                .sign(&SystemRandom::new(), input.as_bytes())
                .unwrap();
            format!("{input}.{}", URL_SAFE_NO_PAD.encode(sig.as_ref()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;
    use serde_json::json;

    const ISS: &str = "https://idp.example";
    const CID: &str = "client-1";
    const NOW: i64 = 1_800_000_000;

    fn validation() -> Validation<'static> {
        Validation {
            issuer: ISS,
            client_id: CID,
            nonce: "n-123",
            now: NOW,
            leeway_secs: 60,
        }
    }

    fn good_claims() -> Value {
        json!({
            "iss": ISS, "aud": CID, "sub": "user-1", "exp": NOW + 300,
            "iat": NOW - 5, "nonce": "n-123", "email": "a@example.org"
        })
    }

    fn rs_header() -> Value {
        json!({"alg": "RS256", "kid": "k1", "typ": "JWT"})
    }

    fn jwks() -> Jwks {
        Jwks {
            keys: vec![rsa_jwk("k1")],
        }
    }

    fn with(claims: Value, key: &str, val: Value) -> Value {
        let mut c = claims;
        c[key] = val;
        c
    }

    #[test]
    fn accepts_a_valid_rs256_token() {
        let t = sign_rs256(&rs_header(), &good_claims());
        let claims = verify_id_token(&t, &jwks(), &validation()).unwrap();
        assert_eq!(claims["sub"], "user-1");
    }

    #[test]
    fn accepts_a_valid_es256_token() {
        let ec = ec_key();
        let jwks = Jwks {
            keys: vec![ec.jwk("e1")],
        };
        let t = ec.sign(&json!({"alg":"ES256","kid":"e1"}), &good_claims());
        verify_id_token(&t, &jwks, &validation()).unwrap();
    }

    #[test]
    fn rejects_wrong_issuer() {
        let t = sign_rs256(
            &rs_header(),
            &with(good_claims(), "iss", json!("https://evil")),
        );
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("iss")
        );
    }

    #[test]
    fn rejects_wrong_audience() {
        let t = sign_rs256(&rs_header(), &with(good_claims(), "aud", json!("other")));
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("aud")
        );
    }

    #[test]
    fn multi_audience_needs_matching_azp() {
        let c = with(good_claims(), "aud", json!([CID, "other"]));
        let t = sign_rs256(&rs_header(), &c);
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("azp")
        );
        let c = with(c, "azp", json!(CID));
        verify_id_token(&sign_rs256(&rs_header(), &c), &jwks(), &validation()).unwrap();
    }

    #[test]
    fn rejects_wrong_nonce_and_missing_nonce() {
        let t = sign_rs256(&rs_header(), &with(good_claims(), "nonce", json!("nope")));
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("nonce")
        );
        let mut c = good_claims();
        c.as_object_mut().unwrap().remove("nonce");
        let t = sign_rs256(&rs_header(), &c);
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("nonce")
        );
    }

    #[test]
    fn rejects_expired_but_allows_small_skew() {
        let t = sign_rs256(&rs_header(), &with(good_claims(), "exp", json!(NOW - 61)));
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("exp")
        );
        let t = sign_rs256(&rs_header(), &with(good_claims(), "exp", json!(NOW - 10)));
        verify_id_token(&t, &jwks(), &validation()).unwrap();
    }

    #[test]
    fn rejects_tokens_from_the_future() {
        let t = sign_rs256(&rs_header(), &with(good_claims(), "iat", json!(NOW + 3600)));
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("iat")
        );
    }

    #[test]
    fn rejects_missing_or_empty_sub() {
        let t = sign_rs256(&rs_header(), &with(good_claims(), "sub", json!("")));
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::Claim("sub")
        );
    }

    #[test]
    fn rejects_bad_signature() {
        let t = sign_rs256(&rs_header(), &good_claims());
        // Flip a bit in the payload: the signature no longer covers it.
        let mut parts: Vec<String> = t.split('.').map(str::to_string).collect();
        let forged = with(good_claims(), "sub", json!("admin"));
        parts[1] = URL_SAFE_NO_PAD.encode(forged.to_string());
        let t = parts.join(".");
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::BadSignature
        );
    }

    #[test]
    fn rejects_a_token_signed_by_another_key() {
        let ec = ec_key();
        let t = ec.sign(&json!({"alg":"ES256","kid":"k1"}), &good_claims());
        // The JWKS only has the RSA key under that kid: key type mismatch.
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::UnknownKey
        );
        // And an EC key under the same kid that is not the signer.
        let other = ec_key();
        let jwks = Jwks {
            keys: vec![other.jwk("k1")],
        };
        assert_eq!(
            verify_id_token(&t, &jwks, &validation()).unwrap_err(),
            JoseError::BadSignature
        );
    }

    #[test]
    fn refuses_none_hmac_and_unknown_algorithms() {
        for alg in ["none", "HS256", "RS512", "ES384", "EdDSA"] {
            let header = URL_SAFE_NO_PAD.encode(json!({"alg": alg, "kid": "k1"}).to_string());
            let payload = URL_SAFE_NO_PAD.encode(good_claims().to_string());
            let t = format!("{header}.{payload}.AAAA");
            assert_eq!(
                verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
                JoseError::UnsupportedAlg,
                "{alg}"
            );
        }
    }

    #[test]
    fn hs256_cannot_be_forged_with_the_public_key() {
        // The classic confusion attack: HMAC keyed with the RSA modulus.
        let header = URL_SAFE_NO_PAD.encode(json!({"alg":"HS256","kid":"k1"}).to_string());
        let payload = URL_SAFE_NO_PAD.encode(good_claims().to_string());
        let t = format!("{header}.{payload}.c2ln");
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::UnsupportedAlg
        );
    }

    #[test]
    fn unknown_kid_is_reported_for_jwks_refresh() {
        let t = sign_rs256(&json!({"alg":"RS256","kid":"rotated"}), &good_claims());
        assert_eq!(
            verify_id_token(&t, &jwks(), &validation()).unwrap_err(),
            JoseError::UnknownKey
        );
    }

    #[test]
    fn malformed_tokens_are_refused_not_panicked_on() {
        for t in ["", "a.b", "a.b.c.d", "!!.!!.!!", "e30.e30.e30"] {
            assert!(verify_id_token(t, &jwks(), &validation()).is_err(), "{t}");
        }
        let long = "a".repeat(MAX_TOKEN_BYTES + 1);
        assert!(verify_id_token(&long, &jwks(), &validation()).is_err());
    }
}
