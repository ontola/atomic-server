import path from 'node:path';
import fs from 'node:fs';
import {
  CollectionBuilder,
  core,
  ErrorType,
  isAtomicError,
  Store,
} from '@tomic/lib';
import type { Resource } from '@tomic/lib';
import {
  type ExecutionContext,
  type TemplateKey,
  templates,
} from './templates.js';
import chalk from 'chalk';
import { log } from './utils.js';
import { getPackagemanager } from './packageManager.js';

export interface PostProcessContext {
  folderPath: string;
  template: TemplateKey;
  serverUrl: string;
  drive: string;
  cmsUrl: string;
}

export async function postProcess(context: PostProcessContext) {
  const { folderPath, template, serverUrl, drive, cmsUrl } = context;

  const store = new Store({ serverUrl });
  const baseTemplate = templates[template];
  const ontology = await findByLocalId(
    store,
    drive,
    baseTemplate.ontologyLocalId,
  );
  const website = await findByLocalId(
    store,
    drive,
    baseTemplate.websiteLocalId,
  );

  if (!ontology || ontology.error || !website || website.error) {
    const error = ontology?.error ?? website?.error;

    if (error && isAtomicError(error)) {
      switch (error.type) {
        case ErrorType.NotFound:
          console.error(
            `\nThe '${baseTemplate.name}' template does not exist in drive '${drive}'. To get the template go to the Create Resource page and select the ${baseTemplate.name} template.`,
          );
          break;
        case ErrorType.Unauthorized:
          console.error(
            '\nSome of the template resources could not be accessed. Make sure the resources are public.',
          );
          break;
        case ErrorType.Server:
          console.error(
            '\nServer Error: Something went wrong while fetching the template.',
          );
          break;
        default:
          console.error('\nAn error occurred while fetching the template.');
      }
    } else {
      console.error(error?.message ?? 'Template resources could not be found.');
    }

    process.exit(1);
  }

  // A freshly applied template is not immediately usable: the server
  // finishes writing the imported resources asynchronously, and until then
  // fetching them errors or yields property-less stubs. `update-ontologies`
  // (the documented next step) needs the ontology and all of its members, so
  // wait for them here instead of handing the user a broken project.
  log('Waiting for the template resources to become available...');
  const readyOntology = await waitForMaterialized(store, ontology.subject);
  await waitForMaterialized(store, website.subject);

  const subjectsOf = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];

  const ontologyMembers = [
    ...subjectsOf(readyOntology.get(core.properties.classes)),
    ...subjectsOf(readyOntology.get(core.properties.properties)),
    ...subjectsOf(readyOntology.get(core.properties.instances)),
  ];

  for (const member of ontologyMembers) {
    await waitForMaterialized(store, member);
  }

  const executionContext: ExecutionContext = {
    serverUrl,
    drive,
    websiteSubject: website.subject,
    cmsUrl,
  };

  await modifyConfig(folderPath, ontology, serverUrl);
  await modifyReadme(folderPath);
  await createEnvFile(folderPath, baseTemplate.generateEnv(executionContext));
}

/**
 * How long to keep probing for the template resources before giving up.
 * The server indexes and persists freshly imported resources asynchronously
 * (observed to take up to ~30s for the website template), so a query or fetch
 * fired right after the template import can miss even though the import
 * succeeded — the polls below use the queried/fetched state itself as the
 * readiness signal.
 */
const FIND_TIMEOUT_MS = 60_000;
const FIND_RETRY_INTERVAL_MS = 500;

const wait = (ms: number) =>
  new Promise(resolve => {
    setTimeout(resolve, ms);
  });

/**
 * Polls until the resource is fully readable: fetching it succeeds and it
 * carries its `isA` — freshly imported resources briefly error or come back
 * as property-less stubs while the server finishes writing them.
 */
async function waitForMaterialized(
  store: Store,
  subject: string,
): Promise<Resource> {
  const deadline = Date.now() + FIND_TIMEOUT_MS;
  let last: Resource | undefined;

  while (Date.now() < deadline) {
    try {
      const resource = await store.fetchResourceFromServer(subject, {
        noWebSocket: true,
      });
      last = resource;

      if (!resource.error && resource.getClasses().length > 0) {
        return resource;
      }
    } catch (_e) {
      // Treat a failed fetch like a not-yet-ready resource and retry.
    }

    await wait(FIND_RETRY_INTERVAL_MS);
  }

  console.error(
    `\nTimed out waiting for template resource ${subject} to become available: ${last?.error?.message ?? 'resource has no class'}`,
  );
  process.exit(1);
}

async function findByLocalId(store: Store, drive: string, localId: string) {
  const deadline = Date.now() + FIND_TIMEOUT_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const collection = await new CollectionBuilder(store)
      .setDrive(drive)
      .setProperty(core.properties.localId)
      .setValue(localId)
      // Template localIds are identical in every drive the template was
      // applied to, and the server's basic property/value index spans all
      // drives it hosts — constrain on the drive property so we resolve the
      // resource in *this* drive instead of an arbitrary one.
      .addFilter({
        property: 'https://atomicdata.dev/properties/drive',
        value: drive,
      })
      .setPageSize(1)
      .buildAndFetch();

    if (collection.totalMembers > 0) {
      const subject = await collection.getMemberWithIndex(0);

      if (subject) {
        return store.getResource(subject);
      }
    }

    if (Date.now() >= deadline) {
      return undefined;
    }

    await wait(FIND_RETRY_INTERVAL_MS);
  }
}

async function modifyConfig(
  folderPath: string,
  ontology: Resource,
  serverUrl: string,
) {
  log(`Generating ${chalk.gray('atomic.config.json')}...`);
  const configPath = path.join(folderPath, 'atomic.config.json');
  const content = await fs.promises.readFile(configPath, { encoding: 'utf-8' });

  const newContent = content
    .replaceAll('<ONTOLOGY>', ontology.subject)
    .replaceAll('<SERVER_URL>', serverUrl);

  await fs.promises.writeFile(configPath, newContent);
}

async function modifyReadme(folderPath: string) {
  log(`Generating ${chalk.gray('README.md')}...`);
  const readmePath = path.join(folderPath, 'README.md');
  const content = await fs.promises.readFile(readmePath, { encoding: 'utf-8' });

  const packageManager = getPackagemanager();
  const newContent = content
    .replaceAll('<PACKAGE_MANAGER>', packageManager)
    .replaceAll(
      '<PACKAGE_MANAGER_RUN>',
      packageManager === 'npm' ? 'npm run' : packageManager,
    );

  await fs.promises.writeFile(readmePath, newContent);
}

async function createEnvFile(folderPath: string, envContent: string) {
  log(`Generating ${chalk.gray('.env')} file...`);

  const envPath = path.join(folderPath, '.env');
  await fs.promises.writeFile(envPath, envContent);
}
