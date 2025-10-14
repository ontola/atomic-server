# Agents

An agent is an authenticated identity that can interact with Atomic Data resources.
All writes in AtomicServer are signed by an agent and can therefore be proven to be authentic.
Read more about agents in the [Atomic Data specification](../agents.md).

## Agent Secret

Agents can be encoded into a single string called a secret.
This secret contains the private key and the subject of the agent.

Encoding and decoding secrets is easy:

```ts
// Encode as secret
const secret = agent.buildSecret();

// Decode from secret
const agent = Agent.fromSecret(secret);
```

## Manual creation

It is recommended to use the `Agent.fromSecret` method to create an agent instance but you can also manually create an agent instance by passing in the private key and the subject.

```typescript
const agent = new Agent('my-private-key', 'my-agent-subject');
```

## Advanced

### Getting the public key

If you need the agents public key you can use the async `getPublicKey` method.

```typescript
const publicKey = await agent.getPublicKey();
```

This will generate a public key from the private key and cache it on the agent instance.

### Verifying the public key

If you need to verify the public key of the agent you can use the `verifyPublicKeyWithServer` method.

```typescript
await agent.verifyPublicKeyWithServer();
```

This will fetch the agent from the server and check if the public key matches the one on the agent instance.
