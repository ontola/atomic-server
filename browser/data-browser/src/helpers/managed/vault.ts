import { getManagedApiBase } from './api';

/**
 * Cloud Vault client: encrypted, blind backup of a drive.
 *
 * The division of labour is deliberate. **WASM does crypto and format, this
 * file does the network.** `vaultExport` hands back bytes that are already
 * sealed; everything here only ever moves ciphertext around. The control plane
 * brokers presigned URLs and never sees a payload, and object bytes go straight
 * to storage rather than through the API — which is why a backup of a large
 * drive does not cost us bandwidth.
 *
 * What that means for reading this file: nothing here can leak drive contents,
 * because nothing here can read them. The security-critical code is in
 * `atomic_lib::vault`; this is plumbing.
 */

/** One confirmed object, from `GET /api/cloud-vault/{drive}/objects`. */
export type VaultObject = {
  object_id: string;
  object_key: string;
  kind: string;
  size_bytes: number;
  key_epoch: number;
  lane_device_pubkey: string | null;
  segment: number | null;
};

type UploadUrl = {
  object_id: string;
  object_key: string;
  url: string;
  method: string;
  headers: [string, string][];
  size_bytes: number;
};

type DownloadUrl = {
  object_id: string;
  object_key: string;
  url: string;
};

export type VaultEnrollment = {
  id: string;
  drive_subject: string;
  drive_pseudonym: string;
  status: string;
  used_bytes: number;
  quota_bytes: number;
  last_backup_at: number | null;
};

export type BackupOutcome =
  | { status: 'nothing-to-do' }
  | { status: 'backed-up'; resources: number; bytes: number; objectKey: string };

export type RestoreOutcome = {
  packsRead: number;
  resourcesRestored: number;
  tombstonesApplied: number;
};

/**
 * The subset of the WASM `ClientDb` this module needs.
 *
 * Declared structurally rather than imported so this file does not depend on
 * which wasm binding module the host wires up — the worker and the tests pass
 * different ones.
 */
export type VaultCapableDb = {
  vaultExport(
    driveSubject: string,
    key: Uint8Array,
    keyEpoch: number,
    drivePseudonym: string,
    devicePubkey: string,
    segment: number,
  ): Promise<{
    objectKey: string;
    sealed: Uint8Array;
    resources: number;
    tombstones: number;
  } | null>;
  vaultImport(
    key: Uint8Array,
    keyEpoch: number,
    drivePseudonym: string,
    devicePubkey: string,
    objects: { objectKey: string; sealed: Uint8Array }[],
  ): Promise<RestoreOutcome>;
};

async function api<T>(
  path: string,
  init?: RequestInit & { body?: string },
): Promise<T> {
  const response = await fetch(`${getManagedApiBase()}${path}`, {
    credentials: 'include',
    ...init,
    headers: init?.body
      ? { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
      : init?.headers,
  });

  if (!response.ok) {
    // The control plane answers 402 when a plan does not cover this, and the
    // body carries an upgrade URL. Surfacing the server's own message beats a
    // generic failure, which is what a user would otherwise see for a billing
    // problem.
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Cloud Vault request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

export async function enrollVault(
  driveSubject: string,
  agentSubject: string,
): Promise<VaultEnrollment> {
  const created = await api<{ enrollment: VaultEnrollment }>(
    '/cloud-vault/enroll',
    {
      method: 'POST',
      body: JSON.stringify({
        drive_subject: driveSubject,
        agent_subject: agentSubject,
      }),
    },
  );

  return created.enrollment;
}

export async function listVaultDrives(): Promise<VaultEnrollment[]> {
  return api<VaultEnrollment[]>('/cloud-vault/drives');
}

export async function disableVault(drivePseudonym: string): Promise<void> {
  await api(`/cloud-vault/${drivePseudonym}/disable`, {
    method: 'POST',
    body: '{}',
  });
}

/**
 * Store this drive's wrapped vault key.
 *
 * The envelope is sealed under the account's agent secret, which never leaves
 * the browser — the control plane holds ciphertext it cannot open, the same
 * boundary as the recovery-secret blob. Storing it is what makes a wiped device
 * recoverable, and it is why enabling backup asks the user to remember nothing.
 */
export async function putVaultKeyEnvelope(
  drivePseudonym: string,
  envelope: string,
): Promise<void> {
  await api(`/cloud-vault/${drivePseudonym}/key`, {
    method: 'PUT',
    body: JSON.stringify({ envelope }),
  });
}

/**
 * Fetch this drive's wrapped vault key, or null if none was ever stored.
 *
 * `204` rather than `404` when absent, so a caller can tell "no key yet" from
 * "no such drive" — the first is a drive that has never been backed up, the
 * second is a mistake.
 */
export async function getVaultKeyEnvelope(
  drivePseudonym: string,
): Promise<string | null> {
  const response = await fetch(
    `${getManagedApiBase()}/cloud-vault/${drivePseudonym}/key`,
    { credentials: 'include' },
  );

  if (response.status === 204) return null;

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? `Could not fetch the vault key (${response.status})`);
  }

  const record = (await response.json()) as { envelope: string };

  return record.envelope;
}

export async function listVaultObjects(
  drivePseudonym: string,
): Promise<VaultObject[]> {
  return api<VaultObject[]>(`/cloud-vault/${drivePseudonym}/objects`);
}

/**
 * Back a drive up: seal locally, upload straight to storage, then tell the
 * control plane what landed.
 *
 * The order matters. The object is confirmed only *after* storage accepted it,
 * so a failed upload leaves a reservation that expires rather than usage the
 * user never consumed. Confirming first would make quota drift upward on every
 * dropped connection.
 */
export async function backupDrive({
  db,
  driveSubject,
  drivePseudonym,
  devicePubkey,
  driveKey,
  keyEpoch = 1,
  segment,
}: {
  db: VaultCapableDb;
  driveSubject: string;
  drivePseudonym: string;
  devicePubkey: string;
  driveKey: Uint8Array;
  keyEpoch?: number;
  segment: number;
}): Promise<BackupOutcome> {
  const sealedPack = await db.vaultExport(
    driveSubject,
    driveKey,
    keyEpoch,
    drivePseudonym,
    devicePubkey,
    segment,
  );

  // An untouched drive produces nothing, so an idle device does not upload an
  // object every tick.
  if (!sealedPack) return { status: 'nothing-to-do' };

  const { uploads } = await api<{ uploads: UploadUrl[] }>(
    `/cloud-vault/${drivePseudonym}/upload-urls`,
    {
      method: 'POST',
      body: JSON.stringify({
        objects: [
          {
            kind: 'pack',
            size_bytes: sealedPack.sealed.length,
            key_epoch: keyEpoch,
            lane_device_pubkey: devicePubkey,
            segment,
          },
        ],
      }),
    },
  );

  const upload = uploads[0];

  // The server decides where an object lives; the client never picks its own
  // location. A mismatch means the two sides disagree about the key layout,
  // which would otherwise only surface as a restore that comes up short.
  if (upload.object_key !== sealedPack.objectKey) {
    throw new Error(
      `Vault key mismatch: control plane issued ${upload.object_key}, client sealed ${sealedPack.objectKey}`,
    );
  }

  const put = await fetch(upload.url, {
    method: 'PUT',
    body: sealedPack.sealed as BodyInit,
    headers: Object.fromEntries(
      // Content-Length is set by the browser and cannot be assigned; passing it
      // through would throw before the request is made.
      upload.headers.filter(([name]) => name.toLowerCase() !== 'content-length'),
    ),
  });

  if (!put.ok) {
    throw new Error(`Vault upload failed (${put.status})`);
  }

  await api(`/cloud-vault/${drivePseudonym}/confirm-upload`, {
    method: 'POST',
    body: JSON.stringify({
      confirmations: [
        { object_id: upload.object_id, size_bytes: sealedPack.sealed.length },
      ],
    }),
  });

  return {
    status: 'backed-up',
    resources: sealedPack.resources,
    bytes: sealedPack.sealed.length,
    objectKey: sealedPack.objectKey,
  };
}

/**
 * Restore a drive from its vault into this device's store.
 *
 * Objects are listed from the control plane rather than guessed: keys are
 * reconstructible from the format, but the ids `download-urls` needs are not,
 * so a device that lost its local state can only learn them by asking.
 *
 * The list arrives ordered by key and is applied in that order. Out of order, a
 * later segment's deletion would be applied before the earlier pack that
 * re-creates the resource, and the delete would be undone.
 */
export async function restoreDrive({
  db,
  drivePseudonym,
  devicePubkey,
  driveKey,
  keyEpoch = 1,
  onProgress,
}: {
  db: VaultCapableDb;
  drivePseudonym: string;
  devicePubkey: string;
  driveKey: Uint8Array;
  keyEpoch?: number;
  onProgress?: (downloaded: number, total: number) => void;
}): Promise<RestoreOutcome> {
  const objects = await listVaultObjects(drivePseudonym);

  if (objects.length === 0) {
    return { packsRead: 0, resourcesRestored: 0, tombstonesApplied: 0 };
  }

  const { downloads } = await api<{ downloads: DownloadUrl[] }>(
    `/cloud-vault/${drivePseudonym}/download-urls`,
    {
      method: 'POST',
      body: JSON.stringify({ object_ids: objects.map(o => o.object_id) }),
    },
  );

  // Preserve the server's ordering: `download-urls` answers per request and is
  // not required to echo the order back.
  const urlByKey = new Map(downloads.map(d => [d.object_key, d.url]));
  const fetched: { objectKey: string; sealed: Uint8Array }[] = [];

  for (const [index, object] of objects.entries()) {
    const url = urlByKey.get(object.object_key);

    if (!url) {
      throw new Error(`No download URL issued for ${object.object_key}`);
    }

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(
        `Vault download failed for ${object.object_key} (${response.status})`,
      );
    }

    fetched.push({
      objectKey: object.object_key,
      sealed: new Uint8Array(await response.arrayBuffer()),
    });
    onProgress?.(index + 1, objects.length);
  }

  return db.vaultImport(
    driveKey,
    keyEpoch,
    drivePseudonym,
    devicePubkey,
    fetched,
  );
}

/**
 * The key-management half of the client.
 *
 * Kept separate from the transport above because it is where the "no second
 * secret" promise is actually kept: a drive key is generated once, wrapped
 * under the agent secret, and handed to the control plane as ciphertext. From
 * then on any device that can sign in as this account can get it back.
 */
export type VaultKeyOps = {
  vaultGenerateKey(): Uint8Array;
  vaultWrapKey(driveKey: Uint8Array, agentSecret: Uint8Array): string;
  vaultUnwrapKey(envelope: string, agentSecret: Uint8Array): Uint8Array;
};

/**
 * Turn Cloud Vault on for a drive and make sure its key is recoverable.
 *
 * Enrolls, then generates and stores a wrapped key — but only if the drive does
 * not already have one. Re-running on a drive that is already set up returns
 * the existing key rather than minting a new one: a second key would leave
 * every object written under the first permanently unreadable, which is the
 * worst thing this module could do.
 */
export async function setUpVaultForDrive({
  keys,
  driveSubject,
  agentSubject,
  agentSecret,
}: {
  keys: VaultKeyOps;
  driveSubject: string;
  agentSubject: string;
  agentSecret: Uint8Array;
}): Promise<{ enrollment: VaultEnrollment; driveKey: Uint8Array }> {
  const enrollment = await enrollVault(driveSubject, agentSubject);
  const existing = await getVaultKeyEnvelope(enrollment.drive_pseudonym);

  if (existing) {
    return {
      enrollment,
      driveKey: keys.vaultUnwrapKey(existing, agentSecret),
    };
  }

  const driveKey = keys.vaultGenerateKey();
  // Stored before anything is backed up. A key that exists only in memory when
  // the first upload happens would leave objects nobody can open if the tab
  // closed in between.
  await putVaultKeyEnvelope(
    enrollment.drive_pseudonym,
    keys.vaultWrapKey(driveKey, agentSecret),
  );

  return { enrollment, driveKey };
}

/**
 * Recover a drive's key on a device that has none.
 *
 * This is the step that makes "clear site data, sign in, restore" work: the
 * envelope comes from the control plane, the agent secret comes from signing
 * in, and neither alone is enough.
 */
export async function recoverDriveKey({
  keys,
  drivePseudonym,
  agentSecret,
}: {
  keys: VaultKeyOps;
  drivePseudonym: string;
  agentSecret: Uint8Array;
}): Promise<Uint8Array> {
  const envelope = await getVaultKeyEnvelope(drivePseudonym);

  if (!envelope) {
    throw new Error(
      'This drive has no stored vault key, so its backups cannot be decrypted.',
    );
  }

  return keys.vaultUnwrapKey(envelope, agentSecret);
}
