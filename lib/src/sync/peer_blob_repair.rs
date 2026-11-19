//! Reconcile file contents independently of the drive's resource versions.

use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};

use tokio::{sync::mpsc, time::Instant};

use crate::{agents::ForAgent, urls, Db, Resource, Storelike, Subject};

use super::{
    engine::collect_drive_subjects,
    peer::{frame_with_len, live_peer_agent},
    protocol,
};

const CHECK_INTERVAL: Duration = Duration::from_secs(1);
const SCAN_INTERVAL: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
const RECENT_REQUESTS: usize = 8;

type BlobHash = [u8; 32];

struct Request {
    subject: String,
    hash: BlobHash,
    agent: ForAgent,
    sent: Instant,
}

#[derive(Default)]
pub(super) struct BlobRepair(Mutex<VecDeque<Request>>);

impl BlobRepair {
    pub(super) fn requested_subject(&self, hash: &BlobHash, agent: &ForAgent) -> Option<String> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .rev()
            .find(|request| request.hash == *hash && request.agent == *agent)
            .map(|request| request.subject.clone())
    }

    pub(super) fn complete(&self, hash: &BlobHash, agent: &ForAgent) {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|request| request.hash != *hash || request.agent != *agent);
    }

    fn waiting(&self, agent: &ForAgent) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .back()
            .is_some_and(|request| {
                request.agent == *agent && request.sent.elapsed() < REQUEST_TIMEOUT
            })
    }

    fn record(&self, request: Request) {
        let mut requests = self.0.lock().unwrap_or_else(|e| e.into_inner());
        requests.retain(|old| old.hash != request.hash || old.agent != request.agent);
        if requests.len() >= RECENT_REQUESTS {
            requests.pop_front();
        }
        // The timeout lets other files make progress. A slow valid response
        // can still be arriving after the next request has been sent.
        requests.push_back(request);
    }
}

fn stored_resource(store: &Db, subject: &str, domain: Option<&str>) -> Option<Resource> {
    Some(Resource::from_propvals(
        store.get_propvals(subject).ok()?,
        Subject::from_raw(subject, domain),
    ))
}

pub(super) async fn can_repair(
    store: &Db,
    drive: &str,
    subject: &str,
    hash: &BlobHash,
    agent: &ForAgent,
) -> bool {
    let base_domain = store.get_base_domain();
    let domain = base_domain.as_deref();
    let Some(resource) = stored_resource(store, subject, domain) else {
        return false;
    };
    if resource.blob_hash().as_ref() != Some(hash)
        || !belongs_to_drive(store, &resource, drive, domain)
    {
        return false;
    }
    crate::hierarchy::check_read(store, &resource, agent)
        .await
        .is_ok()
}

fn belongs_to_drive(store: &Db, resource: &Resource, drive: &str, domain: Option<&str>) -> bool {
    if !Subject::from_raw(drive, domain).is_did() {
        let subject = resource.get_subject_enum().pure_id();
        return subject == drive
            || subject
                .strip_prefix(drive.trim_end_matches('/'))
                .is_some_and(|suffix| suffix.starts_with('/'));
    }

    let mut current = resource.clone();
    let mut visited = HashSet::new();
    loop {
        let subject = current.get_subject_enum().pure_id();
        if subject == drive {
            return true;
        }
        if !visited.insert(subject) {
            return false;
        }
        let Ok(parent) = current.get(urls::PARENT) else {
            return false;
        };
        let parent = Subject::from_raw(&parent.to_string(), domain).pure_id();
        let Some(stored_parent) = stored_resource(store, &parent, domain) else {
            return false;
        };
        current = stored_parent;
    }
}

pub(super) fn start(
    store: Db,
    peer: String,
    drive: String,
    generation: u64,
    tx: mpsc::Sender<Vec<u8>>,
) -> Arc<BlobRepair> {
    let repair = Arc::new(BlobRepair::default());
    let worker = repair.clone();

    tokio::spawn(async move {
        let mut checks = tokio::time::interval_at(Instant::now() + CHECK_INTERVAL, CHECK_INTERVAL);
        checks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let base_domain = store.get_base_domain();
        let drive_subject = Subject::from_raw(&drive, base_domain.as_deref());
        let mut last_scan: Option<(u64, Instant)> = None;
        let mut candidates = VecDeque::new();
        let mut present = HashSet::new();
        loop {
            checks.tick().await;
            let Some(agent) = live_peer_agent(&peer, generation) else {
                break;
            };
            if !matches!(agent, ForAgent::AgentSubject(_))
                || worker.waiting(&agent)
                || !store.sync_policy().admit_drive_write(&drive)
            {
                continue;
            }
            let current_generation = store.write_log().generation();
            if last_scan.is_none_or(|(previous_generation, scanned_at)| {
                previous_generation != current_generation && scanned_at.elapsed() >= SCAN_INTERVAL
            }) {
                let subjects = collect_drive_subjects(&store, &drive_subject).await;
                let mut files: HashSet<_> = subjects
                    .into_iter()
                    .filter_map(|subject| {
                        let resource = stored_resource(&store, &subject, base_domain.as_deref())?;
                        Some((subject, resource.blob_hash()?))
                    })
                    .collect();
                let referenced: HashSet<_> = files.iter().map(|(_, hash)| *hash).collect();
                present.retain(|hash| referenced.contains(hash));
                // Keep the retry order when other resources in the drive change.
                candidates.retain(|file| files.remove(file));
                candidates.extend(files);
                last_scan = Some((current_generation, Instant::now()));
            }

            for _ in 0..candidates.len() {
                let Some((subject, hash)) = candidates.pop_front() else {
                    break;
                };
                if present.contains(&hash) {
                    continue;
                }
                if store.has_blob(&hash).await.unwrap_or(false) {
                    present.insert(hash);
                    continue;
                }
                candidates.push_back((subject.clone(), hash));
                if !can_repair(&store, &drive, &subject, &hash, &agent).await
                    || live_peer_agent(&peer, generation).as_ref() != Some(&agent)
                {
                    continue;
                }

                worker.record(Request {
                    subject,
                    hash,
                    agent,
                    sent: Instant::now(),
                });
                if tx
                    .send(frame_with_len(&protocol::encode_blob_request(&hash)))
                    .await
                    .is_err()
                {
                    return;
                }
                // Wait for this file (or its timeout) before requesting another.
                break;
            }
        }
    });
    repair
}
