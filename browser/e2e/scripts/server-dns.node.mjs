import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const preload = fileURLToPath(new URL('./server-dns.cjs', import.meta.url));

test('Node maps the CI server host without changing HTTP identity or other hosts', async t => {
  const server = createServer((request, response) => {
    response.end(request.headers.host);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const canonical = `http://atomic.test.invalid:${port}`;
  const service = `http://127.0.0.1:${port}`;
  const { stdout } = await execute(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `import { promises as dns } from 'node:dns';
       const response = await fetch(process.env.SERVER_URL);
       const direct = await fetch(process.env.ATOMIC_SERVICE_URL);
       const address = await dns.lookup('atomic.test.invalid');
       console.log(JSON.stringify([await response.text(), await direct.text(), address.address]));`,
    ],
    {
      env: {
        ...process.env,
        SERVER_URL: canonical,
        ATOMIC_SERVICE_URL: service,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      },
      timeout: 5000,
    },
  );
  assert.deepEqual(JSON.parse(stdout), [
    `atomic.test.invalid:${port}`,
    `127.0.0.1:${port}`,
    '127.0.0.1',
  ]);
});
