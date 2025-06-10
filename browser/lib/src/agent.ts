import { Client } from './client.js';
import {
  JSCryptoProvider,
  SubtleCryptoProvider,
  type CryptoProvider,
} from './CryptoProvider.js';
import { AtomicError, ErrorType } from './error.js';
import { core } from './ontologies/core.js';

export interface StoredAgent {
  subject: string;
  keys: CryptoKeyPair;
}

/**
 * An Agent is a user or machine that can read and/or write data to an Atomic Server. An
 * Agent *might* not have a subject. https://atomicdata.dev/classes/Agent
 */
export class Agent implements AgentInterface {
  public client: Client;
  private _subject?: string;

  #cryptoProvider: CryptoProvider;

  public constructor(provider: CryptoProvider, subject?: string) {
    if (subject) {
      Client.tryValidSubject(subject);
    }

    this.client = new Client();
    this._subject = subject;
    this.#cryptoProvider = provider;
  }

  public get subject(): string | undefined {
    return this._subject;
  }

  /**
   * Parses a base64 JSON object containing a privateKey and subject, and
   * constructs an Agent from that.
   */
  public static fromSecret(secretB64: string, type?: 'subtle'): Promise<Agent>;
  public static fromSecret(secretB64: string, type: 'js'): Agent;
  public static fromSecret(
    secretB64: string,
    type: 'js' | 'subtle' = 'subtle',
  ): Agent | Promise<Agent> {
    if (type === 'js') {
      const [provider, subject] = JSCryptoProvider.fromSecret(secretB64);

      return new Agent(provider, subject);
    }

    return new Promise((resolve, reject) => {
      SubtleCryptoProvider.createKeysFromSecret(secretB64)
        .then(([keys, subject]) => {
          const provider = new SubtleCryptoProvider(keys);
          const agent = new Agent(provider, subject);

          resolve(agent);
        })
        .catch(reject);
    });
  }

  public static fromCryptoKeyPair(
    keyPair: CryptoKeyPair,
    subject?: string,
  ): Agent {
    const provider = new SubtleCryptoProvider(keyPair);

    return new Agent(provider, subject);
  }

  /**
   * Builds a secret from a private key and a subject. Give this to a user to store safely or store it in a database.
   */
  public static buildSecret(privateKey: string, subject: string): string {
    const objJsonStr = JSON.stringify({
      privateKey: privateKey,
      subject: subject,
    });

    return btoa(objJsonStr);
  }

  /** Returns public key or generates one using the private key */
  public async getPublicKey(): Promise<string> {
    const publicKey = await this.#cryptoProvider.getPublicKey();

    return publicKey;
  }

  public async sign(message: string): Promise<string> {
    return this.#cryptoProvider.sign(message);
  }

  public createSignature(subject: string, timestamp: number): Promise<string> {
    const message = `${subject} ${timestamp}`;

    return this.sign(message);
  }

  /**
   * Returns a base64 encoded JSON object containing the Subject and the Private
   * Key. Used for signing in with one string
   */

  /** Fetches the public key for the agent, checks if it matches with the current one */
  public async verifyPublicKeyWithServer(): Promise<void> {
    if (!this.subject) {
      throw new AtomicError(`Agent has no subject`, ErrorType.Client);
    }

    const { resource } = await this.client.fetchResourceHTTP(this.subject);

    if (resource.error) {
      throw new Error(
        `Could not fetch agent, and could therefore not check validity of public key. ${resource.error}`,
      );
    }

    const fetchedPubKey = resource.get(core.properties.publicKey)?.toString();

    if (fetchedPubKey !== (await this.getPublicKey())) {
      throw new Error(
        'Fetched publickey does not match current one - is the private key correct?',
      );
    }
  }
}

/**
 * An Agent is a user or machine that can write data to an Atomic Server. An
 * Agent *might* not have subject, sometimes. https://atomicdata.dev/classes/Agent
 */
export interface AgentInterface {
  /** https://atomicdata.dev/properties/publicKey */
  publicKey?: string;
  /** URL of the Agent */
  subject?: string;
}
