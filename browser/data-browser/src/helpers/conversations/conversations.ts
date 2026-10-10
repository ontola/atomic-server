import {
  blobSubject,
  bytesToHex,
  conversations,
  core,
  Datatype,
  server,
  type Agent,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  CARRIER_FILENAME,
  CARRIER_MIMETYPE,
  describeRefusal,
  isRasterImage,
  refuseAttachments,
  type SealedAttachment,
} from './attachments';
import {
  addEpoch,
  encryptionKeyFor,
  sealFile,
  sealPayload,
  type ConversationMember,
} from './conversationCrypto';

/**
 * Starting, finding and posting in encrypted conversations (DMs and group
 * chats). A conversation is a drive of its own: its members can read it and
 * append to it, and nobody can change it, its creator included, because a
 * `write` on the drive would reach every message in it. Each message is
 * writable by its author only. Messages are SealedMessages, so its host
 * stores ciphertext. See
 * `planning/encrypted-conversations.md`.
 */

const APPEND = 'https://atomicdata.dev/properties/append';

/** Thrown when someone can't be messaged yet. */
export class NoEncryptionKeyError extends Error {
  constructor(public readonly agent: string) {
    super(
      'This person has no encryption key yet. They need to open Atomic once before you can message them.',
    );
  }
}

function requireSubject(agent: Agent | undefined): string {
  if (!agent?.subject) {
    throw new Error('Sign in to use messages.');
  }

  return agent.subject;
}

/**
 * Publishes the agent's `encryptionKey` on its Agent resource, so others can
 * start a conversation with it. Does nothing when it is already there. The key
 * is derived from the agent's own key, so every device publishes the same one.
 */
export async function ensureEncryptionKey(
  store: Store,
  agent: Agent,
): Promise<string> {
  const subject = requireSubject(agent);
  const key = await encryptionKeyFor(agent);
  const agentResource = await store.getResource(subject);

  if (agentResource.error) {
    throw agentResource.error;
  }

  if (agentResource.get(conversations.properties.encryptionKey) !== key) {
    await agentResource.set(conversations.properties.encryptionKey, key, false);
    await agentResource.save();
  }

  return key;
}

/** Someone's `encryptionKey`, read fresh from their Agent resource. */
async function memberFor(
  store: Store,
  agent: string,
): Promise<ConversationMember> {
  const resource = await store.fetchResourceFromServer(agent);
  const key = resource.get(conversations.properties.encryptionKey);

  if (typeof key !== 'string' || key === '') {
    throw new NoEncryptionKeyError(agent);
  }

  return { agent, encryptionKey: key };
}

/** Whether `conversation` has exactly these members. */
export function hasMembers(conversation: Resource, members: string[]): boolean {
  const read = conversation.get(core.properties.read);

  if (!Array.isArray(read) || read.length !== new Set(members).size) {
    return false;
  }

  return members.every(member => read.includes(member));
}

/**
 * Creates a conversation between the signed-in agent and `others`, and
 * returns it saved. The caller lists it on the private drive.
 */
export async function startConversation(
  store: Store,
  others: string[],
): Promise<Resource> {
  const agent = store.getAgent();
  const me = requireSubject(agent);
  const memberSubjects = [me, ...others.filter(other => other !== me)];

  if (memberSubjects.length < 2) {
    throw new Error('Pick someone to message.');
  }

  // Publish our own key first: the others need it to add us to a later epoch.
  const myKey = await ensureEncryptionKey(store, agent!);
  const members = [
    { agent: me, encryptionKey: myKey },
    ...(await Promise.all(
      memberSubjects.slice(1).map(other => memberFor(store, other)),
    )),
  ];
  const keyring = await addEpoch(members);

  const conversation = await store.newResource({
    isA: [conversations.classes.conversation, server.classes.drive],
    noParent: true,
    propVals: {
      // Stored data, not UI text: the page shows the members instead.
      [core.properties.name]: /* @wc-ignore */ 'Conversation',
      [core.properties.read]: memberSubjects,
      [APPEND]: memberSubjects,
      [conversations.properties.conversationKeys]: keyring,
    },
    // `append` and the keyring are not in the cached ontology on first use.
    propDatatypes: {
      [APPEND]: Datatype.RESOURCEARRAY,
      [conversations.properties.conversationKeys]: Datatype.STRING,
    },
  });

  await conversation.save();
  // The server grants the creator `write` at genesis. Give it up, or the
  // creator could rewrite what the others said.
  conversation.remove(core.properties.write);
  await conversation.save();

  return conversation;
}

/** The pixel size of a raster image, to reserve its space before it is opened. */
async function imageSize(
  file: File,
): Promise<{ width?: number; height?: number }> {
  if (!isRasterImage(file.type) || typeof createImageBitmap !== 'function') {
    return {};
  }

  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();

    return size;
  } catch {
    return {};
  }
}

/**
 * Encrypts one file for `conversation` on this device. Returns what goes
 * inside the sealed message, and the opaque file that gets uploaded: its name
 * and type say nothing, and its size is the only thing the host learns.
 */
export async function encryptAttachment(
  store: Store,
  conversation: string,
  file: File,
): Promise<{ attachment: SealedAttachment; carrier: File }> {
  const clientDb = store.getClientDb();

  if (!clientDb) {
    throw new Error(
      'Attachments need local storage, which this browser could not open.',
    );
  }

  const { key, ciphertext } = await sealFile(
    conversation,
    new Uint8Array(await file.arrayBuffer()),
  );
  // The hash of the ciphertext, which is what the blob is stored under.
  const hash = bytesToHex(await clientDb.blake3Hash(ciphertext));

  return {
    attachment: {
      blob: blobSubject(hash),
      key,
      name: file.name,
      type: file.type,
      size: file.size,
      ...(await imageSize(file)),
    },
    carrier: new File([ciphertext as BlobPart], CARRIER_FILENAME, {
      type: CARRIER_MIMETYPE,
    }),
  };
}

/**
 * Encrypts `text` and posts it in `conversation`, with `files` attached.
 *
 * Each file is encrypted here under a key of its own; the key, the real name
 * and the type travel inside the sealed message. The ciphertext is uploaded as
 * a blob through the local database (a member may only append, and `/upload`
 * needs write access), as a `File` under the member's own message.
 */
export async function sendSealedMessage(
  store: Store,
  conversation: Resource,
  text: string,
  replyTo?: string,
  files: File[] = [],
): Promise<void> {
  const agent = store.getAgent();
  const me = requireSubject(agent);
  const keyring = conversation.get(conversations.properties.conversationKeys);

  if (typeof keyring !== 'string') {
    throw new Error('This conversation has no keys, so nothing can be sent.');
  }

  const refusal = refuseAttachments([], files);

  if (refusal) {
    throw new Error(describeRefusal(refusal));
  }

  // One at a time: only one plaintext is in memory at once.
  const attachments: SealedAttachment[] = [];
  const carriers: File[] = [];

  for (const file of files) {
    const { attachment, carrier } = await encryptAttachment(
      store,
      conversation.subject,
      file,
    );
    attachments.push(attachment);
    carriers.push(carrier);
  }

  const sealed = await sealPayload(agent!, keyring, conversation.subject, {
    text,
    replyTo,
    attachments: attachments.length > 0 ? attachments : undefined,
  });

  const message = await store.newResource({
    parent: conversation.subject,
    isA: conversations.classes.sealedMessage,
    propVals: {
      [conversations.properties.sealed]: sealed,
      // Members may only append; the message stays writable by its author.
      [core.properties.write]: [me],
    },
  });

  await message.save();
  store.notifyResourceManuallyCreated(message);

  if (carriers.length === 0) {
    return;
  }

  // After the message: a member may append under their own message only once
  // it exists, and the blob is admitted through the File that names it.
  try {
    await store.uploadFiles(carriers, message.subject);
  } catch (error) {
    // A message that points at files that never arrive is worse than none.
    await message.destroy().catch(() => undefined);
    throw error;
  }
}
