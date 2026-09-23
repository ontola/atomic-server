import { describe, expect, it } from 'vitest';
import { Agent } from './agent.js';

describe('issue #1649: deployed agent secret', () => {
  it('accepts an atomic:agent secret through the sign-in parser', async () => {
    const keys = await Agent.generateKeyPair();
    const subject = `atomic:agent:${keys.publicKey}`;
    // Pin the JSON/base64 format exported by app.atomic.place independently
    // of this client's secret builder.
    const secret = btoa(
      JSON.stringify({ privateKey: keys.privateKey, subject }),
    );

    const agent = await Agent.fromSecret(secret);
    expect(agent.subject).toBe(subject);
    expect(await agent.getPublicKey()).toBe(keys.publicKey);
  });
});
