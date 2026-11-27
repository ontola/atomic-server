import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();

// Independent authenticated S3 client for checking real ciphertext. The app
// itself still uses the control plane's signed URLs and production crypto.
export async function startStorage(ctx) {
  const accessKey = `ci${randomBytes(12).toString('hex')}`;
  const secretKey = randomBytes(32).toString('hex');
  const origin = 'http://localhost:9101';
  const bucket = 'native-vault-recovery';
  await ctx.spawn(
    'minio',
    [
      'server',
      join(ctx.runDir, 's3-data'),
      '--address',
      '127.0.0.1:9101',
      '--console-address',
      '127.0.0.1:9102',
    ],
    {
      env: {
        MINIO_ROOT_USER: accessKey,
        MINIO_ROOT_PASSWORD: secretKey,
        MINIO_API_CORS_ALLOW_ORIGIN: '*',
      },
    },
  );
  await ctx.wait('real MinIO readiness', async () => {
    try {
      return (
        await fetch(`${origin}/minio/health/ready`, {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  });

  const request = async (method, path, data = Buffer.alloc(0)) => {
    const url = new URL(path, origin);
    assert.equal(url.origin, origin);
    const stamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const date = stamp.slice(0, 8);
    const scope = `${date}/us-east-1/s3/aws4_request`;
    const payloadHash = sha256(data);
    const headers = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const query = [...url.searchParams]
      .sort()
      .map(
        ([key, value]) =>
          `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
      )
      .join('&');
    const canonical = [
      method,
      url.pathname,
      query,
      headers,
      signedHeaders,
      payloadHash,
    ].join('\n');
    let key = Buffer.from(`AWS4${secretKey}`);
    for (const item of [date, 'us-east-1', 's3', 'aws4_request'])
      key = hmac(key, item);
    const signature = hmac(
      key,
      `AWS4-HMAC-SHA256\n${stamp}\n${scope}\n${sha256(canonical)}`,
    ).toString('hex');
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(20_000),
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': stamp,
        Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(['PUT', 'POST'].includes(method) ? { body: data } : {}),
    });
    assert(response.ok, `Real S3 ${method} failed (${response.status}).`);

    return {
      status: response.status,
      body: Buffer.from(await response.arrayBuffer()),
    };
  };

  await request('PUT', `/${bucket}`);
  const probe = randomBytes(128);
  await request('PUT', `/${bucket}/setup-probe`, probe);
  assert.deepEqual(
    (await request('GET', `/${bucket}/setup-probe`)).body,
    probe,
  );
  await request('DELETE', `/${bucket}/setup-probe`);
  ctx.s3 = { request, origin, bucket };

  const binary = process.env.NATIVE_RECOVERY_SAAS_BINARY;
  assert(
    binary,
    'Supply the real Cloud Vault API binary; no in-memory replacement is supported.',
  );
  await ctx.spawn(binary, [], {
    env: {
      DB_PATH: join(ctx.runDir, 'saas.redb'),
      ATOMIC_SAAS_PORT: '3031',
      SAAS_URL: ctx.vaultOrigin,
      ATOMIC_APP_HOST: 'localhost:9883',
      ATOMIC_SAAS_NODE_PROVIDER: 'local-process',
      ATOMIC_SAAS_LOCAL_NODE_BINARY: join(ctx.runDir, 'never-launch-a-server'),
      ATOMIC_SAAS_DEV_MAGIC_LINKS: 'true',
      ATOMIC_SAAS_SIGNUP_PER_IP_CAP: '10000',
      ATOMIC_SAAS_SIGNUP_EMAIL_COOLDOWN_SECS: '0',
      ATOMIC_SAAS_SKIP_NODE_HEALTH_CHECKS: 'true',
      ATOMIC_SAAS_DEV_NODE_ORIGIN: 'localhost:9883',
      POSTMARK_TOKEN: 'mock',
      ATOMIC_SAAS_LOAD_DEV_ENV: '',
      SENTRY_DSN: '',
      SENTRY_DSN_BROWSER: '',
      RUST_LOG: 'warn',
      ATOMIC_VAULT_REQUIRE_S3: '1',
      ATOMIC_VAULT_S3_BUCKET: bucket,
      ATOMIC_VAULT_S3_REGION: 'us-east-1',
      ATOMIC_VAULT_S3_ENDPOINT: origin,
      ATOMIC_VAULT_S3_ALLOW_HTTP: '1',
      ATOMIC_VAULT_S3_VIRTUAL_HOSTED: '0',
      ATOMIC_VAULT_S3_ACCESS_KEY: accessKey,
      ATOMIC_VAULT_S3_SECRET_KEY: secretKey,
      ATOMIC_VAULT_PSEUDONYM_SALT: randomBytes(32).toString('hex'),
    },
  });
  await ctx.wait('real Cloud Vault API readiness', async () => {
    try {
      return (
        (
          await fetch(`${ctx.vaultOrigin}/api/me`, {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 204
      );
    } catch {
      return false;
    }
  });
}
