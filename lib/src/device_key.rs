//! Device-local storage for an agent's Ed25519 secret, for browser apps on the
//! main thread (async IndexedDB + WebCrypto; no workers needed).
//!
//! With `wrap = true` the secret is encrypted with AES-GCM under a
//! non-extractable `CryptoKey` that lives in the same IndexedDB. Script
//! cannot read that key's bytes, so a copy of the storage (a profile or
//! backup dump, a leaked IndexedDB export) holds only ciphertext.
//!
//! Threat model, honestly: this does NOT defend against script running in
//! your origin. An XSS can call [`load_device_key`] (or just sign with the
//! decrypted secret) exactly like your own code. The wrapping key also sits in
//! the same browser profile, so it does not help against someone who can use
//! the live profile. It protects data at rest and plain exfiltration of the
//! stored value, nothing more. Without `wrap` the secret is stored as-is.

use js_sys::{Function, Object, Promise, Reflect, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;
use web_sys::{IdbDatabase, IdbFactory, IdbOpenDbRequest, IdbRequest, IdbTransactionMode};

const DB_NAME: &str = "atomic-device-key";
const STORE: &str = "keys";
const WRAP_KEY_ID: &str = "wrap-key";

fn get(o: &JsValue, k: &str) -> Result<JsValue, JsValue> {
    Reflect::get(o, &k.into())
}

/// Call `o.method(...args)` and await the returned promise.
async fn call(o: &JsValue, method: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let f: Function = get(o, method)?.dyn_into()?;
    let p = match args {
        [a] => f.call1(o, a),
        [a, b] => f.call2(o, a, b),
        [a, b, c] => f.call3(o, a, b, c),
        _ => Err(JsValue::from_str("unsupported arg count")),
    }?;
    JsFuture::from(Promise::from(p)).await
}

/// A promise that settles on the first of the given events of `target`.
fn on_event(target: &web_sys::EventTarget, ok: &str, err: &[&str]) -> Promise {
    Promise::new(&mut |res, rej| {
        let add = |name: &str, f: &Function| {
            let f = f.clone();
            let cb = Closure::once_into_js(move |ev: JsValue| {
                let _ = f.call1(&JsValue::NULL, &ev);
            });
            let _ = target.add_event_listener_with_callback(name, cb.unchecked_ref());
        };
        add(ok, &res);
        for e in err {
            add(e, &rej);
        }
    })
}

async fn open_db() -> Result<IdbDatabase, JsValue> {
    let factory: IdbFactory = get(&js_sys::global(), "indexedDB")?.dyn_into()?;
    let req: IdbOpenDbRequest = factory.open_with_u32(DB_NAME, 1)?;
    let upgrade = Closure::<dyn FnMut(web_sys::Event)>::new(move |ev: web_sys::Event| {
        let req: IdbRequest = ev.target().unwrap().unchecked_into();
        let db: IdbDatabase = req.result().unwrap().unchecked_into();
        let _ = db.create_object_store(STORE);
    });
    req.set_onupgradeneeded(Some(upgrade.as_ref().unchecked_ref()));
    JsFuture::from(on_event(&req, "success", &["error", "blocked"])).await?;
    req.result()?.dyn_into()
}

async fn idb_get(db: &IdbDatabase, key: &str) -> Result<JsValue, JsValue> {
    let store = db.transaction_with_str(STORE)?.object_store(STORE)?;
    let req = store.get(&key.into())?;
    JsFuture::from(on_event(&req, "success", &["error"])).await?;
    req.result()
}

async fn idb_put(db: &IdbDatabase, key: &str, value: &JsValue) -> Result<(), JsValue> {
    let tx = db.transaction_with_str_and_mode(STORE, IdbTransactionMode::Readwrite)?;
    tx.object_store(STORE)?.put_with_key(value, &key.into())?;
    JsFuture::from(on_event(&tx, "complete", &["error", "abort"])).await?;
    Ok(())
}

/// The non-extractable AES-GCM key, created on first use.
async fn wrap_key(db: &IdbDatabase, subtle: &JsValue) -> Result<JsValue, JsValue> {
    let existing = idb_get(db, WRAP_KEY_ID).await?;
    if !existing.is_undefined() {
        return Ok(existing);
    }
    let algo = Object::new();
    Reflect::set(&algo, &"name".into(), &"AES-GCM".into())?;
    Reflect::set(&algo, &"length".into(), &256.into())?;
    let usages = js_sys::Array::of2(&"encrypt".into(), &"decrypt".into());
    let key = call(
        subtle,
        "generateKey",
        &[algo.into(), false.into(), usages.into()],
    )
    .await?;
    idb_put(db, WRAP_KEY_ID, &key).await?;
    Ok(key)
}

fn aes_params(iv: &Uint8Array) -> Result<Object, JsValue> {
    let p = Object::new();
    Reflect::set(&p, &"name".into(), &"AES-GCM".into())?;
    Reflect::set(&p, &"iv".into(), iv)?;
    Ok(p)
}

fn subtle() -> Result<JsValue, JsValue> {
    get(&get(&js_sys::global(), "crypto")?, "subtle")
}

/// Store `secret` for `agent_id`, wrapped with a non-extractable key if `wrap`.
pub async fn store_device_key(
    agent_id: &str,
    secret: &[u8; 32],
    wrap: bool,
) -> Result<(), JsValue> {
    let db = open_db().await?;
    let rec = Object::new();
    let data = Uint8Array::from(&secret[..]);
    if wrap {
        let subtle = subtle()?;
        let key = wrap_key(&db, &subtle).await?;
        let mut iv_bytes = [0u8; 12];
        getrandom::fill(&mut iv_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let iv = Uint8Array::from(&iv_bytes[..]);
        let ct = call(
            &subtle,
            "encrypt",
            &[aes_params(&iv)?.into(), key, data.into()],
        )
        .await?;
        Reflect::set(&rec, &"iv".into(), &iv)?;
        Reflect::set(&rec, &"data".into(), &Uint8Array::new(&ct))?;
    } else {
        Reflect::set(&rec, &"data".into(), &data)?;
    }
    idb_put(&db, &format!("agent:{agent_id}"), &rec).await
}

/// Load the secret stored for `agent_id`, or `None`.
pub async fn load_device_key(agent_id: &str) -> Result<Option<[u8; 32]>, JsValue> {
    let db = open_db().await?;
    let rec = idb_get(&db, &format!("agent:{agent_id}")).await?;
    if rec.is_undefined() {
        return Ok(None);
    }
    let data = get(&rec, "data")?;
    let iv = get(&rec, "iv")?;
    let bytes = if iv.is_undefined() {
        Uint8Array::new(&data).to_vec()
    } else {
        let subtle = subtle()?;
        let key = wrap_key(&db, &subtle).await?;
        let pt = call(
            &subtle,
            "decrypt",
            &[aes_params(&iv.unchecked_into())?.into(), key, data],
        )
        .await?;
        Uint8Array::new(&pt).to_vec()
    };
    bytes
        .try_into()
        .map(Some)
        .map_err(|_| JsValue::from_str("stored device key has the wrong length"))
}

/// Remove the stored secret for `agent_id`.
pub async fn delete_device_key(agent_id: &str) -> Result<(), JsValue> {
    let db = open_db().await?;
    let tx = db.transaction_with_str_and_mode(STORE, IdbTransactionMode::Readwrite)?;
    tx.object_store(STORE)?
        .delete(&format!("agent:{agent_id}").into())?;
    JsFuture::from(on_event(&tx, "complete", &["error", "abort"])).await?;
    Ok(())
}
