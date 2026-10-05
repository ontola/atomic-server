import { Chat } from '@ai-sdk/react';
import type { ChatTransport } from 'ai';
import type { AtomicUIMessage } from './types';

export type ChatRunHandlers = {
  onFinish: (arg: {
    message: AtomicUIMessage;
    messages: AtomicUIMessage[];
    isError: boolean;
  }) => void;
  onError: (error: Error) => void;
  /** Persist the latest message of a run nobody is looking at. */
  save: (message: AtomicUIMessage) => void | Promise<void>;
};

export interface ChatRun {
  chat: Chat<AtomicUIMessage>;
  /** Always the callbacks of the component that was mounted last. */
  handlers: ChatRunHandlers;
  mounts: number;
  detachedTimer?: ReturnType<typeof setInterval>;
}

const runs = new Map<string, ChatRun>();

const isRunning = (run: ChatRun) =>
  run.chat.status === 'submitted' || run.chat.status === 'streaming';

/**
 * A chat's run (the stream, its tool calls) used to belong to the chat
 * component, so leaving the chat page cut the reply off halfway. Runs now live
 * here, per chat resource: the page attaches to the run while it is mounted,
 * and the run carries on, and keeps saving, while the reader is elsewhere.
 */
export function getRun(subject: string): ChatRun | undefined {
  const run = runs.get(subject);

  if (run && !isRunning(run) && run.mounts === 0) {
    runs.delete(subject);

    return undefined;
  }

  return run;
}

export function createRun(
  subject: string,
  transport: ChatTransport<AtomicUIMessage>,
  messages: AtomicUIMessage[],
  generateId: () => string,
  handlers: ChatRunHandlers,
): ChatRun {
  const run: ChatRun = {
    handlers,
    mounts: 0,
    chat: new Chat<AtomicUIMessage>({
      transport,
      messages,
      generateId,
      onError: error => run.handlers.onError(error),
      onFinish: arg => {
        run.handlers.onFinish(arg);

        if (run.mounts === 0) {
          stopDetachedSaving(run);
          runs.delete(subject);
        }
      },
    }),
  };
  runs.set(subject, run);

  return run;
}

/** The page shows this run again: it takes over saving. */
export function attachRun(run: ChatRun) {
  run.mounts += 1;
  stopDetachedSaving(run);
}

/** The page is gone. A reply still streaming keeps being saved. */
export function detachRun(run: ChatRun) {
  run.mounts = Math.max(0, run.mounts - 1);

  if (run.mounts > 0 || !isRunning(run) || run.detachedTimer) return;

  let lastSaved = '';
  run.detachedTimer = setInterval(() => {
    if (!isRunning(run)) return stopDetachedSaving(run);

    const latest = run.chat.messages.at(-1);

    if (!latest || latest.role !== 'assistant' || latest.parts.length === 0)
      return;

    const fingerprint = JSON.stringify(latest);

    if (fingerprint === lastSaved) return;

    lastSaved = fingerprint;
    void run.handlers.save(structuredClone(latest));
  }, 1000);
}

function stopDetachedSaving(run: ChatRun) {
  clearInterval(run.detachedTimer);
  run.detachedTimer = undefined;
}
