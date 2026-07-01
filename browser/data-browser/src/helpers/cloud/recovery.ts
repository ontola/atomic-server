import { getCloudApiBase } from './api';
import { writeCloudAccountBinding } from './binding';

export type RecoverySecretInput = {
  agent_subject: string;
  drive_subject?: string | null;
  encrypted_secret: string;
  encryption_algorithm: string;
  kdf_algorithm: string;
  kdf_params: Record<string, unknown>;
  salt: string;
  nonce: string;
  format_version: number;
};

export type RecoverySecret = RecoverySecretInput & {
  owner_email: string;
  created_at: number;
  updated_at: number;
};

const RECOVERY_FORMAT_VERSION = 1;
const KDF_ITERATIONS = 310_000;
const KDF_HASH = 'SHA-256';
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  return bytes;
}

async function deriveRecoveryKey(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!globalThis.crypto?.subtle?.importKey) {
    throw new Error('This browser does not support encrypted recovery.');
  }

  const passwordKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );

  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: KDF_ITERATIONS,
      hash: KDF_HASH,
    },
    passwordKey,
    { name: 'AES-GCM', length: 256 },
    false,
    usages,
  );
}

export async function buildEncryptedRecoverySecret({
  secret,
  password,
  agentSubject,
  driveSubject,
}: {
  secret: string;
  password: string;
  agentSubject: string;
  driveSubject?: string | null;
}): Promise<RecoverySecretInput> {
  const salt = randomBytes(SALT_BYTES);
  const nonce = randomBytes(NONCE_BYTES);
  const key = await deriveRecoveryKey(password, salt, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce },
    key,
    new TextEncoder().encode(secret),
  );

  return {
    agent_subject: agentSubject,
    drive_subject: driveSubject ?? null,
    encrypted_secret: bytesToBase64(new Uint8Array(ciphertext)),
    encryption_algorithm: 'AES-GCM',
    kdf_algorithm: 'PBKDF2',
    kdf_params: {
      hash: KDF_HASH,
      iterations: KDF_ITERATIONS,
    },
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    format_version: RECOVERY_FORMAT_VERSION,
  };
}

/**
 * Reverse of {@link buildEncryptedRecoverySecret}: derive the AES-GCM key from
 * the recovery password + stored salt, then decrypt the agent secret. Throws a
 * friendly error on a wrong password (AES-GCM auth-tag failure).
 */
export async function decryptRecoverySecret(
  recovery: RecoverySecret,
  password: string,
): Promise<string> {
  const salt = base64ToBytes(recovery.salt);
  const nonce = base64ToBytes(recovery.nonce);
  const key = await deriveRecoveryKey(password, salt, ['decrypt']);

  let plaintext: ArrayBuffer;

  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      base64ToBytes(recovery.encrypted_secret),
    );
  } catch {
    throw new Error('Wrong recovery password, or the backup is corrupted.');
  }

  return new TextDecoder().decode(plaintext);
}

export async function saveRecoverySecret(input: RecoverySecretInput) {
  const response = await fetch(`${getCloudApiBase()}/recovery-secret`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? 'Sign in to Cloud Sync before enabling encrypted recovery.'
        : 'Could not save encrypted recovery backup.',
    );
  }

  const saved = (await response.json()) as RecoverySecret;
  writeCloudAccountBinding(saved.owner_email, saved.agent_subject);

  return saved;
}

export async function getRecoverySecret(): Promise<RecoverySecret | null> {
  // [RECOVERY-RECONSTRUCTED] body — only this function's signature survived in
  // the transcripts. Reconstructed as the GET counterpart of saveRecoverySecret
  // (PUT) above; 204/401/404 all mean "no recovery secret stored".
  const response = await fetch(`${getCloudApiBase()}/recovery-secret`, {
    credentials: 'include',
  });

  if (
    response.status === 204 ||
    response.status === 401 ||
    response.status === 404
  ) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Could not load encrypted recovery backup.');
  }

  return (await response.json()) as RecoverySecret;
}