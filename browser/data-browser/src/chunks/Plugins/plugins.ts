import type { JSONValue } from '@tomic/react';
import {
  ZipReader,
  Uint8ArrayReader,
  TextWriter,
  configure,
  type Entry,
} from '@zip.js/zip.js';
import type { JSONSchema7 } from 'ai';
import { Ajv } from 'ajv';

// zip.js defaults to decompressing in a Web Worker spawned from a `blob:`
// URL. The production server's CSP is `worker-src 'self'`
// (server/src/handlers/single_page_app.rs), which blocks blob workers — so
// reading an uploaded plugin zip throws on a real (CSP-enforced) server and
// the "Add Plugin" dialog never opens. (Dev/Vite has no CSP, so it only
// reproduced in the production bundle.) Plugin zips are tiny, so main-thread
// inflate is fine; this keeps the CSP strict instead of allowing `blob:`.
configure({ useWebWorkers: false });

export type PluginPermissionType =
  | 'network'
  | 'storage'
  | 'full-drive-access'
  | 'extended-fuel'
  | 'extended-memory'
  | 'custom-view';
export interface PluginPermission {
  permission: PluginPermissionType;
  reason: string;
}

export interface PluginMetadata {
  name: string;
  namespace: string;
  author?: string;
  description?: string;
  version: string;
  permissions?: PluginPermission[];
  defaultConfig?: JSONValue;
  configSchema?: JSONSchema7;
}

export async function readZip(file: File): Promise<PluginMetadata> {
  const zip = new ZipReader(new Uint8ArrayReader(await file.bytes()));
  const entries = await zip.getEntries();

  if (!validateZip(entries)) {
    throw new Error('Invalid plugin zip file.');
  }

  for (const entry of entries) {
    if (!entry.directory && entry.filename === 'plugin.json') {
      const metadata = await entry.getData(new TextWriter());

      return JSON.parse(metadata) as PluginMetadata;
    }
  }

  throw new Error('Plugin metadata not found in zip file.');
}

function validateZip(entries: Entry[]): boolean {
  const allowedRootFiles = ['plugin.json', 'plugin.wasm', 'ui.js', 'ui.css'];
  let foundWasm = false;
  let foundJson = false;

  for (const entry of entries) {
    if (entry.filename.startsWith('assets/')) {
      continue;
    }

    if (!allowedRootFiles.includes(entry.filename)) {
      return false;
    }

    if (entry.filename === 'plugin.wasm') {
      foundWasm = true;
    }

    if (entry.filename === 'plugin.json') {
      foundJson = true;
    }
  }

  return foundWasm && foundJson;
}

export const validateConfig = (
  config: JSONValue,
  schema: JSONSchema7,
): boolean => {
  const ajv = new Ajv();
  const validate = ajv.compile(schema);

  return validate(config);
};
