//! Mint short-lived FCM OAuth and APNs provider JWTs from files on disk.
//!
//! Operators can still pass pre-minted `ATOMIC_FCM_BEARER_TOKEN` /
//! `ATOMIC_APNS_BEARER_TOKEN`. File-based minting is what production iOS/Android
//! push actually needs (bearers expire in ~1h).

use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

const FCM_SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
const GOOGLE_TOKEN_AUD: &str = "https://oauth2.googleapis.com/token";

/// APNs provider JWT (ES256). Apple allows `iat` only — no `exp`. Valid ≤ 1h.
#[derive(Debug, Serialize, Deserialize)]
pub struct ApnsJwtClaims {
    pub iss: String,
    pub iat: u64,
}

/// Google service-account JWT used to exchange an FCM OAuth access token.
#[derive(Debug, Serialize, Deserialize)]
pub struct GoogleJwtClaims {
    pub iss: String,
    pub scope: String,
    pub aud: String,
    pub iat: u64,
    pub exp: u64,
}

pub fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Sign an APNs provider token from a `.p8` (PKCS8) PEM.
pub fn mint_apns_jwt(
    pkcs8_pem: &str,
    key_id: &str,
    team_id: &str,
    iat: u64,
) -> Result<String, String> {
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id.to_string());
    header.typ = Some("JWT".into());
    let key = EncodingKey::from_ec_pem(pkcs8_pem.as_bytes())
        .map_err(|e| format!("APNs .p8 / EC key: {e}"))?;
    encode(
        &header,
        &ApnsJwtClaims {
            iss: team_id.to_string(),
            iat,
        },
        &key,
    )
    .map_err(|e| format!("APNs JWT encode: {e}"))
}

/// Sign a Google OAuth JWT from a service-account RSA private key PEM.
pub fn mint_google_jwt(
    rsa_pem: &str,
    client_email: &str,
    iat: u64,
    lifetime_secs: u64,
) -> Result<String, String> {
    let header = Header::new(Algorithm::RS256);
    let key = EncodingKey::from_rsa_pem(rsa_pem.as_bytes())
        .map_err(|e| format!("FCM service-account RSA key: {e}"))?;
    encode(
        &header,
        &GoogleJwtClaims {
            iss: client_email.to_string(),
            scope: FCM_SCOPE.into(),
            aud: GOOGLE_TOKEN_AUD.into(),
            iat,
            exp: iat.saturating_add(lifetime_secs),
        },
        &key,
    )
    .map_err(|e| format!("FCM JWT encode: {e}"))
}

#[derive(Debug, Clone)]
pub struct ServiceAccount {
    pub project_id: String,
    pub client_email: String,
    pub private_key_pem: String,
}

/// Parse a Google service-account JSON object (file or `ATOMIC_FCM_SERVICE_ACCOUNT_JSON`).
pub fn parse_service_account_json(raw: &str) -> Result<ServiceAccount, String> {
    let v: JsonValue =
        serde_json::from_str(raw).map_err(|e| format!("FCM service-account JSON: {e}"))?;
    let project_id = v
        .get("project_id")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "FCM service-account JSON missing project_id".to_string())?
        .to_string();
    let client_email = v
        .get("client_email")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "FCM service-account JSON missing client_email".to_string())?
        .to_string();
    let private_key_pem = v
        .get("private_key")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "FCM service-account JSON missing private_key".to_string())?
        .replace("\\n", "\n");
    Ok(ServiceAccount {
        project_id,
        client_email,
        private_key_pem,
    })
}

pub fn read_file_trim(path: &str) -> Result<String, String> {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("read {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Throwaway P-256 PKCS8 — tests only, never used in production.
    const APNS_TEST_P8: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgMB6ERah5AET3bfW2
Gqb8F6Rv8D0XRuQ9T9DbJ0u0RGihRANCAASMdplxryNIFYYvS4a/UdEXnQW+HTJl
EW09t4dYq/lKMzvHOCuLp+ToaV+HPfeX6tqBsPG0HqKYr6dNM6iJ/Nmt
-----END PRIVATE KEY-----";

    const FCM_TEST_RSA: &str = "-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCpPK6sdbjvHUXr
3zquUUCOdUmRzvoIIBd46pI8ADVeNf8ulQGSTaHtixemts7G/5IUY77FyCHjMzWv
h9ggPP3kjWEPa64HiUy08KSura6OyYmyg5/di9LsXyGx9xVT5d2u+lRRSPD9Ob4k
V92Yic/XC7n1MNaqiB5B8vRRi5EGmNr3kLuyXM5HiyWXu3elGchkEZRaQgT6jomw
F6hWZAYKbTg4SGnCGkRy8b4yVFiPh3oBFE8O8+wnjgiiaZSracuSSecBATotTgzt
IZN2F613DcwIqbpcLcrblsoI+uc4wotD+0rjRSqkcqOzBL88dQxDIf/6bqEeN7Wn
SDuidMLlAgMBAAECggEAHDLoSAQ1lGIkTHEdrf4L67DPWWRLdR8jyhoL08OVIOWO
Z4ycfmxBFvueLUE4ox/ij1MvbnUycFEQGPdho72F8Jc+HPusO8U86slOJ2z5MQGT
2BLmiFvMAWa4jpbFDv22Onmrov+saAU/EX8yhUAxSXvCuIAyxKd5ozOAUjYXLCn2
fmvPGO05RbhPJjrZk8T9KB5qPW+7mneg9OYpyB5ai13HtQVay71h6sNWjfe/I1Mh
7xtrBol7mhBl1jggZb3vR5GuqakDYcmYCbCKMtFj1dxoLcMOk6w/ApuSD2ebQ0wK
Ei1V8nrKPD6I8vo3iT/Uck0JDUCGlc4qQhPX2EF34QKBgQDhGl8vOVDlCnl58rDl
CAAv7vlOYHnszxHbHNxohjwLsd8LQlXhzEXc5h0nobX+sgZ4Ki4hJfhKFK95J3pa
bM9G+nBjTSZarvXPpFuGN/9Fg/Tg+ICPsGNk8Qiw8c/+bkAUiaa+j3bB1+FSEPVS
ZF9tXP1+mizllv29+QMOIynVSwKBgQDAd01dGawGDTUwph6lBojJ2Yke4DqpF1gH
vaMuOV29unJYx+FH+0OskEVFs7q9AUWek0HW18+Ce50b/AODz/2cqFTGA/HSrL1I
pchmD3/2gIBNSUlSpekXvIu8745vAXoV/vxmEoXn+k+OXMgZThDMbDP+OlXlw+FB
wXHEwCcajwKBgAKWG/vd67kF+slU6YVoJyBl3YVyBFSdOHZNCZdF25DC1W46r+Pt
Rew41KLs77tibkKZMXh+CDFJtY5tzrEVSPhmzj3F2Cf4lKhzGf4bzJoO3xRqpoeA
HlQ9lLz7ukkRGTljL4BHA7VMdrFLspXkw1ftVphKyzNEHdw97TQPYV6rAoGAa08Z
N1tk6kra6TD1zRUDl2dOaISksDpvvoEhRlh9x5b4wj9PgA68AK6/sMkwyMi4xF1e
TCcvb5T0V/H/E7MXuAyyl2UDo27kamjkfuMNeabT4kOGOip+99kMIF+AjqvIIhN1
LoQNXPXW/Y0Fk/ZOr2t04b4svlqkcUEl6YkpREkCgYEAnMmx22xpa4P1K/ayXSyF
KsDSy+zM/NRfMG4tsXI/VCjTpUyfAyhuxi6aGvRFTqtxkns6sU0RjYJPnm3gI82S
e5eUVgfDc7M32zW9ZxiPWRn1CkSk0FUZzBJJS7C0gY0O4UTt6QngxSyRYHHOK130
TyX5wJaEyvq2GK1EmUGKc50=
-----END PRIVATE KEY-----";

    #[test]
    fn apns_jwt_is_three_parts_with_kid() {
        let jwt = mint_apns_jwt(APNS_TEST_P8, "KEYID123", "TEAMID123", 1_700_000_000).unwrap();
        let parts: Vec<_> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        let header = jsonwebtoken::decode_header(&jwt).unwrap();
        assert_eq!(header.alg, Algorithm::ES256);
        assert_eq!(header.kid.as_deref(), Some("KEYID123"));
    }

    #[test]
    fn google_jwt_is_rs256() {
        let jwt = mint_google_jwt(
            FCM_TEST_RSA,
            "firebase-adminsdk@demo.iam.gserviceaccount.com",
            1_700_000_000,
            3600,
        )
        .unwrap();
        let header = jsonwebtoken::decode_header(&jwt).unwrap();
        assert_eq!(header.alg, Algorithm::RS256);
        assert_eq!(jwt.split('.').count(), 3);
    }

    #[test]
    fn parse_service_account_reads_escaped_newlines() {
        let json = r#"{
            "project_id": "demo-project",
            "client_email": "sa@demo-project.iam.gserviceaccount.com",
            "private_key": "-----BEGIN PRIVATE KEY-----\\nLINE\\n-----END PRIVATE KEY-----\\n"
        }"#;
        let sa = parse_service_account_json(json).unwrap();
        assert_eq!(sa.project_id, "demo-project");
        assert!(sa.private_key_pem.contains('\n'));
        assert!(!sa.private_key_pem.contains("\\n"));
    }
}
