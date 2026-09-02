# Agents

An agent is an authenticated identity that can interact with Atomic Data resources.
All writes in AtomicServer are signed by an agent and can therefore be proven to be authentic.
Read more about agents in the [Atomic Data specification](../agents.md).

The Agent signs requests and commits using a Crypto Provider. These handle all the cryptographic operations.
@tomic/lib provides two Crypto Providers:

- `SubtleCryptoProvider` recommended for browser environments.
- `JSCryptoProvider` for JavaScript environments that do not support the SubtleCrypto API.

Using the SubtleCrypto provider is more secure against XSS attacks because the private key is not available to the javascript context.
This means that if there are any bad actors on the page they cannot steal your key, only sign message as you while they are loaded on the page.

## Agent Secret

Agents can be encoded into a single string called a secret.
This secret contains the private key and the subject of the agent.

Encoding and decoding secrets is easy:

```ts
// Create a secret
const secret = Agent.buildSecret('my-private-key', 'my-agent-subject');

// Decode from secret
//  - Using subtle crypto
const agent = await Agent.fromSecret(secret);
//  - Using js crypto
const agent = Agent.fromSecret(secret, 'js');
```

## Manual creation

When creating an agent manually you need to setup a Crypto Provider. This can be done in several ways:

### SubtleCryptoProvider

```ts
  // Using an existing secret

  // Create a key pair from a secret. You can store these to IndexedDB to persist a session.
  const [keyPair, subject] = await SubtleCryptoProvider.createKeysFromSecret('my-secret');
  const provider = new SubtleCryptoProvider(keyPair);
  const agent = new Agent(provider, subject);
```

### JSCryptoProvider

```ts
const [provider, subject] = JSCryptoProvider.fromSecret('my-secret');
const agent = new Agent(provider, subject);
```

## Persisting sessions

If your are using @tomic/lib on the client and you want to persist an agent so the user does not have to login again, you can store the generated CryptoKeyPair in IndexedDB.

You cannot store the key pair in local storage because they cannot be serialized.

```ts
import { set, get } from 'idb-keyval';

// User logs in using their secret:
const [keyPair, subject] = await SubtleCryptoProvider.createKeysFromSecret('my-secret');
const provider = new SubtleCryptoProvider(keyPair);
const agent = new Agent(provider, subject);

// Store the key pair in indexedDB
await set('atomic.agent', { keyPair, subject });

// When the user returns you retrieve the keys and create an agent from them.
const { keyPair, subject } = await get('atomic.agent');
const agent = new Agent(new SubtleCryptoProvider(keyPair), subject);
```

## Advanced

### Getting the public key

If you need the agents public key you can use the async `getPublicKey` method.

```typescript
const publicKey = await agent.getPublicKey();
```

This will generate a public key from the private key and cache it on the agent instance.

### Signing messages with your agent

You can use your agent to sign messages.
In practise you never need to do this yourself but it might be useful when you want to extend Atomic's functionality.

```typescript
const signature = await agent.sign('my-message');
```

### Verifying the public key

If you need to verify the public key of the agent you can use the `verifyPublicKeyWithServer` method.

```typescript
await agent.verifyPublicKeyWithServer();
```

This will fetch the agent from the server and check if the public key matches the one on the agent instance.
