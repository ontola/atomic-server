/* eslint-disable no-console */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import chalk from 'chalk';
import {
  resolveConfig as prettierResolveConfig,
  format as prettierFormat,
} from 'prettier';
import {
  buildSchemaLock,
  verifySchemaLock,
  type DefinedSchema,
  type AtomicSchemaPackage,
  type RegisteredSchema,
} from '@tomic/lib';
import { createConfiguredStore } from '../store.js';
import { atomicConfig } from '../config.js';
import { generateOntology } from '../generateOntology.js';
import { PropertyRecord } from '../PropertyRecord.js';
import { generateExternals } from '../generateExternals.js';
import { generateIndex } from '../generateIndex.js';

type SchemaModule = Record<string, unknown>;
type SchemaInput = DefinedSchema | AtomicSchemaPackage;

interface SchemaCommandOptions {
  exportName: string;
  save: boolean;
  addToConfig: boolean;
  generateBindings: boolean;
  lock: boolean;
}

export const schemaCommand = async (args: string[]) => {
  const [schemaPath, ...rest] = args;

  if (!schemaPath) {
    console.error(
      chalk.red('ERROR: Missing schema module path.'),
      '\nUsage: ad-generate schema ./schema.js [--export todoSchema] [--local] [--generate]',
    );
    process.exit(1);
  }

  const opts = parseOptions(rest);
  const schema = await loadSchema(schemaPath, opts.exportName);
  const store = await createConfiguredStore();

  if (opts.save) {
    store.setServerConnected(true);
  }

  const registered = await store.registerSchema(schema, { save: opts.save });

  if (opts.addToConfig) {
    await addOntologyToConfig(registered.ontology.subject);
  }

  if (opts.generateBindings) {
    await writeOntologyBindings(registered, store);
  }

  if (opts.lock) {
    await writeSchemaLock(schema);
  }

  printRegisteredSchema(registered, opts.save);
};

async function writeSchemaLock(schema: SchemaInput): Promise<void> {
  const lock = buildSchemaLock(schema);
  const verification = verifySchemaLock(lock);

  if (!verification.ok) {
    throw new Error(
      `Refusing to write an invalid schema lock:\n${verification.errors.join('\n')}`,
    );
  }

  const outputFolder = path.resolve(process.cwd(), atomicConfig.outputFolder);
  const filePath = path.join(outputFolder, `${lock.name}.schema.lock.json`);
  await fs.mkdir(outputFolder, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(lock, null, 2)}\n`);

  console.log(chalk.blue('Wrote lockfile'), chalk.cyan(filePath));
}

function parseOptions(args: string[]): SchemaCommandOptions {
  let exportName = 'default';
  let save = true;
  let addToConfig = false;
  let generateBindings = false;
  let lock = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--export' || arg === '-e') {
      exportName = args[i + 1];
      i++;
      continue;
    }

    if (arg === '--local') {
      save = false;
      continue;
    }

    if (arg === '--add-to-config') {
      addToConfig = true;
      continue;
    }

    if (arg === '--generate') {
      generateBindings = true;
      continue;
    }

    if (arg === '--lock') {
      lock = true;
      continue;
    }

    throw new Error(`Unknown schema command option: ${arg}`);
  }

  if (!exportName) {
    throw new Error('Missing value for --export');
  }

  return { exportName, save, addToConfig, generateBindings, lock };
}

async function loadSchema(
  schemaPath: string,
  exportName: string,
): Promise<SchemaInput> {
  const absolutePath = path.resolve(process.cwd(), schemaPath);
  const moduleUrl = pathToFileURL(absolutePath).href;
  const module = (await import(moduleUrl)) as SchemaModule;
  const value = module[exportName];

  if (!isSchemaInput(value)) {
    throw new Error(
      `Export ${exportName} from ${schemaPath} is not a defineSchema() result or schema package.`,
    );
  }

  return value;
}

function isSchemaInput(value: unknown): value is SchemaInput {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if ('schemaHash' in value && 'normalized' in value) {
    return true;
  }

  return 'name' in value && 'classes' in value;
}

function printRegisteredSchema(
  registered: RegisteredSchema,
  saved: boolean,
): void {
  console.log(chalk.green(saved ? 'Published schema' : 'Registered schema'));
  console.log(`${chalk.blue('Ontology:')} ${registered.ontology.subject}`);
  console.log(`${chalk.blue('Hash:')} ${registered.model.ontology.schemaHash}`);
  console.log(
    `${chalk.blue('Classes:')} ${Object.keys(registered.classes).length}`,
  );
  console.log(
    `${chalk.blue('Properties:')} ${Object.keys(registered.properties).length}`,
  );
}

async function addOntologyToConfig(subject: string): Promise<void> {
  const configPath = path.resolve(process.cwd(), './atomic.config.json');
  const raw = await fs.readFile(configPath, 'utf8');
  const config = JSON.parse(raw) as { ontologies?: string[] };
  const ontologies = config.ontologies ?? [];

  if (!ontologies.includes(subject)) {
    config.ontologies = [...ontologies, subject];
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  console.log(`${chalk.blue('Config:')} added ${subject}`);
}

async function writeOntologyBindings(
  registered: RegisteredSchema,
  store: Awaited<ReturnType<typeof createConfiguredStore>>,
): Promise<void> {
  const propertyRecord = new PropertyRecord();
  const ontology = await generateOntology(
    registered.ontology.subject,
    propertyRecord,
    store,
  );

  await writeGeneratedFile(ontology);

  const missingProps = propertyRecord.getMissingProperties();

  if (missingProps.length > 0) {
    const externalsContent = await generateExternals(missingProps, store);
    await writeGeneratedFile({
      filename: 'externals.ts',
      content: externalsContent,
    });
  }

  await writeGeneratedFile(
    generateIndex(
      [registered.ontology.subject],
      missingProps.length > 0,
      store,
    ),
  );
}

async function writeGeneratedFile({
  filename,
  content,
}: {
  filename: string;
  content: string;
}): Promise<void> {
  const outputFolder = path.resolve(process.cwd(), atomicConfig.outputFolder);
  const filePath = path.join(outputFolder, filename);
  await fs.mkdir(outputFolder, { recursive: true });

  let formatted = content;
  const prettierConfig = await prettierResolveConfig(filePath);

  if (prettierConfig) {
    formatted = await prettierFormat(content, {
      ...prettierConfig,
      parser: 'typescript',
    });
  }

  await fs.writeFile(filePath, formatted);
  console.log(chalk.blue('Wrote to'), chalk.cyan(filePath));
}
