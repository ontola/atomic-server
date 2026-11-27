/** Portable artifacts use content hashes rather than engine-local Dagger IDs. */
export type BrowserBundleManifest = {
  version: 2;
  sourceCommit: string;
  sourceFingerprint: string;
  sourceFingerprintVersion: 2;
  platform: 'linux/amd64';
  rustVersion: string;
  pnpmVersion: string;
  playwrightVersion: string;
  files: {
    'atomic-server-binary': string;
    'client.oci.tar': string;
    'checks.oci.tar': string;
    'test-inventory.json': string;
  };
};

export const BROWSER_BUNDLE_PLATFORM = 'linux/amd64';
export const BROWSER_SOURCE_FINGERPRINT_VERSION = 2;

export function validateBundleCommit(commit: string): void {
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error(
      'Browser bundle source commit must be a full lowercase Git SHA',
    );
  }
}

export function validateBundleHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error('Browser bundle hash must be a lowercase SHA256');
  }
}

export function validateBrowserShard(
  index: number,
  count: number,
  workers: number,
  retries: number,
): void {
  for (const [name, value, minimum, maximum] of [
    ['shard-count', count, 1, 128],
    ['shard-index', index, 1, count],
    ['playwright-workers', workers, 1, 128],
    ['playwright-retries', retries, 0, 10],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(
        `${name} must be an integer between ${minimum} and ${maximum}`,
      );
    }
  }
}

/** Fail closed before importing an executable image from another engine. */
export function validateBrowserManifest(
  value: unknown,
  expected: {
    sourceCommit: string;
    sourceFingerprint: string;
    rustVersion: string;
    pnpmVersion: string;
    playwrightVersion: string;
  },
): BrowserBundleManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid browser bundle manifest');
  }
  const manifest = value as BrowserBundleManifest;
  if (
    manifest.version !== 2 ||
    manifest.platform !== BROWSER_BUNDLE_PLATFORM ||
    manifest.sourceFingerprintVersion !== BROWSER_SOURCE_FINGERPRINT_VERSION
  ) {
    throw new Error('Unsupported browser bundle version or platform');
  }
  validateBundleCommit(manifest.sourceCommit);
  validateBundleHash(manifest.sourceFingerprint);
  for (const key of [
    'sourceCommit',
    'sourceFingerprint',
    'rustVersion',
    'pnpmVersion',
    'playwrightVersion',
  ] as const) {
    if (manifest[key] !== expected[key]) {
      throw new Error(`Browser bundle ${key} does not match this checkout`);
    }
  }
  if (!manifest.files || typeof manifest.files !== 'object') {
    throw new Error('Browser bundle file hashes are missing');
  }
  validateBundleHash(manifest.files['atomic-server-binary']);
  validateBundleHash(manifest.files['client.oci.tar']);
  validateBundleHash(manifest.files['checks.oci.tar']);
  validateBundleHash(manifest.files['test-inventory.json']);
  return manifest;
}

/**
 * Canonical source fingerprint across engines: files, executable bits,
 * symlink targets and contents. Empty directories are generated metadata,
 * not build inputs. Every non-ignored file, including untracked files, counts.
 * Run with Node and the module's already-filtered source mounted at /source.
 */
export const BROWSER_SOURCE_FINGERPRINT_SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[1] || '/source';
const hash = crypto.createHash('sha256');
const legacyHash = crypto.createHash('sha256');
const files = [];
const directories = [];
function visit(relative) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isDirectory()) {
    directories.push(relative);
    legacyHash.update(JSON.stringify([relative, 'directory']) + '\n');
    for (const child of fs.readdirSync(absolute).sort()) {
      visit(relative ? relative + '/' + child : child);
    }
  } else if (stat.isSymbolicLink()) {
    const file = [relative, 'symlink', fs.readlinkSync(absolute)];
    files.push(file);
    legacyHash.update(JSON.stringify(file) + '\n');
  } else if (stat.isFile()) {
    const content = crypto.createHash('sha256');
    const fd = fs.openSync(absolute, 'r');
    const buffer = Buffer.alloc(1024 * 1024);
    try {
      let length;
      while ((length = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        content.update(buffer.subarray(0, length));
      }
    } finally { fs.closeSync(fd); }
    const file = [relative, 'file', stat.mode & 0o111, content.digest('hex')];
    files.push(file);
    legacyHash.update(JSON.stringify(file) + '\n');
  } else {
    throw new Error('Unsupported source entry: ' + relative);
  }
}
visit('');
files.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
for (const file of files) hash.update(JSON.stringify(file) + '\n');
const fingerprint = hash.digest('hex');
const legacyFingerprint = legacyHash.digest('hex');
process.stdout.write(process.argv[2] === '--manifest'
  ? JSON.stringify({fingerprintVersion: 2, fingerprint, legacyFingerprint, files, directories: directories.sort()})
  : fingerprint);
`;
