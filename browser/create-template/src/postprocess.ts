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
}

export async function postProcess(context: PostProcessContext) {
  const { folderPath, template, serverUrl, drive } = context;

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

  const executionContext: ExecutionContext = {
    serverUrl,
    drive,
    websiteSubject: website.subject,
  };

  await modifyConfig(folderPath, ontology, serverUrl);
  await modifyReadme(folderPath);
  await createEnvFile(folderPath, baseTemplate.generateEnv(executionContext));
}

async function findByLocalId(store: Store, drive: string, localId: string) {
  const collection = await new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(core.properties.localId)
    .setValue(localId)
    .setPageSize(1)
    .buildAndFetch();
  const subject = await collection.getMemberWithIndex(0);

  return subject ? store.getResource(subject) : undefined;
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
