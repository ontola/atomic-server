import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer, type ServerHandle } from './server-fixture.js';

describe('server-fixture', () => {
  let server: ServerHandle;

  beforeAll(async () => {
    server = await startServer();
  });

  afterAll(async () => {
    await server?.stop();
  });

  it('starts the server and reads bootstrap agent secret', async () => {
    expect(server.serverUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(server.agentSecret).toBeTruthy();
    expect(server.agentSecret.length).toBeGreaterThan(20);

    const res = await fetch(server.serverUrl);
    expect([200, 401, 404]).toContain(res.status);
  });
});
