/**
 * Generic template applier: templates are DATA, not code.
 *
 * A template is a JSON file: { name, description, resolve: [localId...],
 * resources: [JSON-AD with localIds] }. This script creates a public drive,
 * imports the resources, resolves the localIds the consumer needs (per the
 * sanctioned (drive, localId) discovery contract — see
 * planning/website-templates.md), and writes a config JSON mapping:
 *   { serverUrl, drive, subjects: {localId: subject}, props: {shortname: subject} }
 *
 * Every Property resource in the template is resolved into `props`
 * automatically; `resolve` lists additional roots (pages, tables).
 *
 * Usage:
 *   AGENT_SECRET=<b64> SERVER_URL=http://localhost:9885 \
 *   TEMPLATE=/path/to/some-template.json \
 *   CONFIG_OUT=/path/to/consumer/config.json \
 *     npx tsx scripts/apply-template.ts
 *
 * (The AtomicServer.eu salespage template that used to be the example here
 * moved to atomic-saas/portal/scripts/templates/saas-salespage.json — it's
 * company content, not a generic example. This script and the underlying
 * template ontology stay generic and live here.)
 */
import fs from 'node:fs';
import { Agent, Store, core } from '@tomic/lib';

const SERVER_URL = process.env.SERVER_URL ?? 'http://localhost:9885';
const AGENT_SECRET = process.env.AGENT_SECRET;
const TEMPLATE = process.env.TEMPLATE;
const CONFIG_OUT = process.env.CONFIG_OUT;
const PUBLIC_AGENT = 'https://atomicdata.dev/agents/publicAgent';
const PROPERTY_CLASS = 'https://atomicdata.dev/classes/Property';

if (!AGENT_SECRET) throw new Error('Set AGENT_SECRET');
if (!TEMPLATE) throw new Error('Set TEMPLATE (path to template json)');
if (!CONFIG_OUT) throw new Error('Set CONFIG_OUT (path for consumer config json)');

interface Template {
  name: string;
  description?: string;
  resolve?: string[];
  resources: Record<string, unknown>[];
}

async function resolveLocalId(localId: string, drive: string): Promise<string> {
  // Template localIds are identical in every drive the template was applied
  // to — constrain on the `drive` property (like create-template's
  // postprocess does; the `drive` QUERY PARAM does not filter membership).
  const filters = encodeURIComponent(
    JSON.stringify([
      { property: 'https://atomicdata.dev/properties/drive', value: drive },
    ]),
  );
  const url = `${SERVER_URL}/query?property=${encodeURIComponent(
    core.properties.localId,
  )}&value=${encodeURIComponent(localId)}&filters=${filters}`;
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const res = await fetch(url, { headers: { Accept: 'application/ad+json' } });
    const json = await res.json();
    const members: string[] =
      json['https://atomicdata.dev/properties/collection/members'] ?? [];

    if (members.length > 0) return members[0];
    await new Promise(r => setTimeout(r, 500));
  }

  throw new Error(`Timed out resolving localId ${localId}`);
}

async function main() {
  const template: Template = JSON.parse(fs.readFileSync(TEMPLATE!, 'utf8'));
  const store = new Store({ serverUrl: SERVER_URL });
  const agent = await Agent.fromSecret(AGENT_SECRET!);
  store.setAgent(agent);

  // Public read must be granted at genesis: editing rights on a fetched
  // resource does not work headless yet (no Loro doc → no valid commit).
  const drive = await store.newResource({
    isA: 'https://atomicdata.dev/classes/Drive',
    noParent: true,
    propVals: {
      [core.properties.name]: template.name,
      ...(template.description
        ? { [core.properties.description]: template.description }
        : {}),
      [core.properties.write]: [agent.subject!],
      [core.properties.read]: [PUBLIC_AGENT, agent.subject!],
    },
  });
  await drive.save();
  await store.syncDirtyResources();

  await store.importJsonAD(JSON.stringify(template.resources), {
    parent: drive.subject,
  });

  console.log(`Imported ${template.resources.length} resources.`);
  console.log(`Drive: ${drive.subject}`);
  console.log('Resolving subjects...');

  const props: Record<string, string> = {};
  const subjects: Record<string, string> = {};

  for (const resource of template.resources) {
    const isA = (resource[core.properties.isA] as string[]) ?? [];

    if (isA.includes(PROPERTY_CLASS)) {
      const short = String(resource[core.properties.shortname]);
      props[short] = await resolveLocalId(
        String(resource[core.properties.localId]),
        drive.subject,
      );
    }
  }

  for (const localId of template.resolve ?? []) {
    subjects[localId] = await resolveLocalId(localId, drive.subject);
  }

  const config = { serverUrl: SERVER_URL, drive: drive.subject, subjects, props };
  fs.writeFileSync(CONFIG_OUT!, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote config to ${CONFIG_OUT}`);
}

main().then(
  () => process.exit(0),
  err => {
    console.error(err);
    process.exit(1);
  },
);
