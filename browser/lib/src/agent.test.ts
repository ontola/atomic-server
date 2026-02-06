import { describe, it } from 'vitest';
import { Agent } from './agent.js';
import { JSCryptoProvider } from './CryptoProvider.js';

describe('Agent', () => {
  const validPrivateKey = 'CapMWIhFUT+w7ANv9oCPqrHrwZpkP2JhzF9JnyT6WcI=';
  const validSubject =
    'https://atomicdata.dev/agents/PLwTOXVvQdHYpaLEq5IozLNeUBdXMVchKjFwFfamBlo=';

  it('Constructs valid ', async ({ expect }) => {
    const validAgent = () =>
      new Agent(new JSCryptoProvider(validPrivateKey), validSubject);
    expect(validAgent).not.to.throw();
    // Can't get this to throw yet
    // const invalidAgentSignature = () => new Agent(validSubject, 'ugh');
    // expect(invalidAgentSignature).to.throw();
    const invalidAgentUrl = () =>
      new Agent(new JSCryptoProvider(validPrivateKey), 'not a url');
    expect(invalidAgentUrl).to.throw();
  });

  it('signs any string correctly', async ({ expect }) => {
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const input = 'val';
    const correct_signature_rust =
      'YtDR/xo0272LHNBQtDer4LekzdkfUANFTI0eHxZhITXnbC3j0LCqDWhr6itNvo4tFnep6DCbev5OKAHH89+TDA==';
    const signature = await agent.sign(input);
    expect(signature).to.equal(correct_signature_rust);
  });

  it('creates the right public key', async ({ expect }) => {
    const agent = new Agent(
      new JSCryptoProvider(validPrivateKey),
      validSubject,
    );
    const generatedPublickey = await agent.getPublicKey();
    expect(generatedPublickey).to.equal(
      '7LsjMW5gOfDdJzK/atgjQ1t20J/rw8MjVg6xwqm+h8U=',
    );
  });
});
