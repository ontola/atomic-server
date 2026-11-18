#!/usr/bin/env node
/**
 * Genuine local SaaS account/device authorization for native Vault acceptance.
 * No backup/restore shortcuts: the app must perform those through its real UI.
 *
 * bootstrap http://localhost:3031 EMAIL /owned/path/session.json
 * inject /owned/path/session.json EXPECTED_NATIVE_DRIVE
 * inspect /owned/path/session.json
 *
 * Secrets remain in memory or an exclusively-created owner-only state file.
 * inject installs the real device grant in the app's existing storage keys;
 * reload the app normally afterward to refresh its account/session caches.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeBridge } from './native-late-file-acceptance.mjs';

function localOrigin(value) {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Acceptance API must be a credential-free loopback HTTP origin.',
    );

  return url.origin;
}

async function api(origin, path, { method = 'GET', body, cookie, token } = {}) {
  const response = await fetch(`${origin}/api${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // Do not echo response bodies or request URLs containing credentials.
  if (!response.ok)
    throw new Error(
      `Local SaaS ${method} request failed (${response.status}).`,
    );

  return { body: await response.json(), headers: response.headers };
}

function publicAccount(account) {
  return {
    email: account.email,
    address: account.address ?? null,
    linked_agent: account.linked_agent ?? null,
  };
}

export async function bootstrapAccount(origin, email) {
  origin = localOrigin(origin);
  const signup = await api(origin, '/signup', {
    method: 'POST',
    body: { email },
  });
  if (typeof signup.body.magic_link !== 'string')
    throw new Error('Local SaaS must have development magic links enabled.');
  const token = new URL(signup.body.magic_link).searchParams.get('token');
  if (!token)
    throw new Error('Local development signup did not issue a login token.');
  const login = await api(origin, '/login', {
    method: 'POST',
    body: { token },
  });
  const cookie = login.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .find(value => value.startsWith('session_token='));
  if (!cookie) throw new Error('Local login did not issue a session cookie.');
  const requested = await api(origin, '/device-link', {
    method: 'POST',
    body: { device_name: 'Isolated native Vault acceptance' },
  });
  const { device_code, user_code } = requested.body;
  if (typeof device_code !== 'string' || typeof user_code !== 'string')
    throw new Error('Local device authorization did not issue codes.');
  await api(origin, `/device-link/code/${encodeURIComponent(user_code)}`, {
    method: 'POST',
    cookie,
  });
  const approved = await api(
    origin,
    `/device-link/${encodeURIComponent(device_code)}`,
  );
  if (
    approved.body.state !== 'approved' ||
    typeof approved.body.token !== 'string'
  )
    throw new Error('Local device authorization was not approved.');
  const verified = await api(origin, '/me', { token: approved.body.token });
  if (verified.body.email !== login.body.email)
    throw new Error('Device grant resolved to another account.');

  return {
    version: 1,
    origin,
    cookie,
    token: approved.body.token,
    account: publicAccount(verified.body),
  };
}

export async function writePrivateState(file, state) {
  const handle = await open(
    resolve(file),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );

  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`);
  } finally {
    await handle.close();
  }
}

export async function readPrivateState(file) {
  const handle = await open(
    resolve(file),
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );

  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error(
        'State must be an owned regular file readable only by its owner.',
      );
    let state;

    try {
      state = JSON.parse(await handle.readFile('utf8'));
    } catch {
      throw new Error('Could not read acceptance session JSON.');
    }

    if (
      state.version !== 1 ||
      typeof state.token !== 'string' ||
      typeof state.cookie !== 'string'
    )
      throw new Error('Unrecognized acceptance session state.');
    state.origin = localOrigin(state.origin);

    return state;
  } finally {
    await handle.close();
  }
}

export async function injectDeviceGrant(state, expectedDrive) {
  if (!expectedDrive)
    throw new Error(
      'Specify the isolated native app’s expected selected drive.',
    );
  const origin = localOrigin(state.origin);
  const bridge = await NativeBridge.connect();

  try {
    return await bridge.evaluate(`
      if (!window.__TAURI__ || !window.store) throw new Error('No native Atomic app Store.');
      if (window.store.getDrive() !== ${JSON.stringify(expectedDrive)}) throw new Error('Selected native drive differs from the isolated acceptance drive.');
      localStorage.setItem('atomic-managed-device-token', ${JSON.stringify(state.token)});
      localStorage.setItem('atomic-managed-portal-origin-linked', ${JSON.stringify(origin)});
      localStorage.setItem('atomic-managed-portal-url', ${JSON.stringify(origin)});
      return { state: 'linked', portal: ${JSON.stringify(origin)}, drive: window.store.getDrive(), agent: window.store.getAgent()?.subject ?? null, reloadRequired: true };
    `);
  } finally {
    bridge.close();
  }
}

export async function inspectVault(state) {
  const origin = localOrigin(state.origin);
  const auth = { token: state.token };
  const account = await api(origin, '/me', auth);
  const enrollments = await api(origin, '/cloud-vault/drives', auth);
  if (!Array.isArray(enrollments.body))
    throw new Error('Expected a Vault enrollment list.');
  const drives = [];

  for (const enrollment of enrollments.body) {
    const id = encodeURIComponent(enrollment.drive_pseudonym);
    const [summary, objects] = await Promise.all([
      api(origin, `/cloud-vault/${id}/state`, auth),
      api(origin, `/cloud-vault/${id}/objects`, auth),
    ]);
    drives.push({
      drive: enrollment.drive_subject,
      pseudonym: enrollment.drive_pseudonym,
      status: enrollment.status,
      last_backup_at: enrollment.last_backup_at,
      state: summary.body,
      objects: objects.body,
    });
  }

  return { account: publicAccount(account.body), drives };
}

async function main([command, first, second, third]) {
  let result;
  if (command === 'bootstrap' && first && second && third) {
    const state = await bootstrapAccount(first, second);
    await writePrivateState(third, state);
    result = {
      account: state.account,
      state: 'device-approved',
      portal: state.origin,
      privateState: resolve(third),
    };
  } else if (command === 'inject' && first && second)
    result = await injectDeviceGrant(await readPrivateState(first), second);
  else if (command === 'inspect' && first)
    result = await inspectVault(await readPrivateState(first));
  else
    throw new Error(
      'Usage: native-vault-acceptance.mjs bootstrap ORIGIN EMAIL PRIVATE_STATE | inject PRIVATE_STATE EXPECTED_DRIVE | inspect PRIVATE_STATE',
    );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
