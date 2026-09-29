import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  createResourceFromCompact,
  dataBrowser,
  expandSubject,
  listDriveClasses,
  queryResources,
  resolveClass,
  readResourceCompact,
  semanticSearch,
  server as serverOntology,
  setResourceProperty,
  shortenRefsDeep,
  shortenSubject,
  textSearch,
  toClassObject,
  type JSONValue,
  type Resource,
  type Store,
} from '@tomic/lib';
import { z } from 'zod';
import { writeDocumentText } from './document-body.js';
import { documentText } from './document-text.js';

/** What the signed-in agent may reach. */
export interface Access {
  /** The drive tools default to: class lookup, search scope. */
  drive: string;
  /** Every drive or folder the agent was granted, `drive` first. */
  targets: string[];
}

export interface AtomicMcpOptions {
  store: Store;
  /**
   * Resolves what this agent may reach, before every tool call. Throws when
   * it has no access yet; the message (e.g. an approval link) is what the
   * model reads, so it can pass it on to the person.
   */
  access: () => Promise<Access>;
  /** Set to false to register only the read tools. */
  allowWrites?: boolean;
}

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

const ok = (value: unknown): ToolResult => ({
  content: [
    {
      type: 'text',
      text:
        typeof value === 'string'
          ? value
          : JSON.stringify(shortenRefsDeep(value), null, 2),
    },
  ],
});

const fail = (error: unknown): ToolResult => ({
  content: [
    {
      type: 'text',
      // Full subjects are long; the model knows them as #refs.
      text: `Error: ${(error instanceof Error ? error.message : String(error)).replace(/did:ad:[\w:-]+/g, shortenSubject)}`,
    },
  ],
  isError: true,
});

/** Runs a tool body, turning a throw into an MCP tool error the model reads. */
const run =
  <A>(body: (args: A) => Promise<unknown>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return ok(await body(args));
    } catch (error) {
      return fail(error);
    }
  };

const hasDocumentBody = (classes: string[]) =>
  classes.includes(dataBrowser.classes.documentV2) ||
  classes.includes(dataBrowser.classes.meeting);

/** Keys that carry a document's text instead of an ordinary property. */
const BODY_KEYS = ['_documentText', 'document-content', 'documentContent'];

function takeBody(data: Record<string, unknown>): {
  body: string | undefined;
  rest: Record<string, unknown>;
} {
  const rest = { ...data };
  let body: string | undefined;

  for (const key of BODY_KEYS) {
    if (key in rest) {
      const value = rest[key];
      delete rest[key];

      if (typeof value !== 'string') {
        throw new Error(`${key} takes Markdown or plain text as a string.`);
      }

      body = value;
    }
  }

  return { body, rest };
}

/** Replaces the text body of `resource` and saves it. */
async function saveDocumentText(resource: Resource, text: string) {
  if (!hasDocumentBody(resource.getClasses())) {
    throw new Error(
      `${shortenSubject(resource.subject)} is not a document or meeting, so it has no text body.`,
    );
  }

  const loro = resource.getLoroDoc();

  if (!loro) {
    throw new Error(
      'Loro is not loaded, so the document text cannot be written.',
    );
  }

  writeDocumentText(loro, text);
  resource.markDirty();
  await resource.save();
}

/**
 * Builds an MCP server whose tools read and edit Atomic Data through `store`,
 * as whatever Agent the store is signed in with. Writes are ordinary signed
 * commits, exactly as if the person made them in the app.
 */
export function createAtomicMcpServer({
  store,
  access,
  allowWrites = true,
}: AtomicMcpOptions): McpServer {
  /** A tool body that needs to know what the agent may reach. */
  const withAccess = <A>(body: (args: A, access: Access) => Promise<unknown>) =>
    run(async (args: A) => body(args, await access()));

  const mcp = new McpServer(
    { name: 'atomic', version: '0.41.0' },
    {
      instructions: `Tools for reading and editing Atomic Data (a graph of resources, each with a subject such as did:ad:… and properties). Results use compact JSON-AD: property shortnames as keys, "@id", "@class" and "@parent" as structural keys, and short refs like #AbCd1234 for subjects, which every tool accepts back. Start with list_drives or search, read resources with get_resource, and use get_user_classes / get_schema before creating resources of a custom class.`,
    },
  );

  mcp.registerTool(
    'list_drives',
    {
      title: 'List drives',
      description:
        'List the drives and folders this connection may reach, and which one is the default for the other tools.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withAccess(async (_args: Record<string, never>, { drive, targets }) => {
      const agent = store.getAgent();
      const subjects = new Set<string>(targets);

      if (agent?.subject) {
        const agentResource = await store.getResource(agent.subject);
        const drives = agentResource.get(serverOntology.properties.drives);

        if (Array.isArray(drives)) {
          for (const subject of drives) subjects.add(String(subject));
        }
      }

      return Promise.all(
        [...subjects].map(async subject => {
          const resource = await store.getResource(subject);

          return {
            subject,
            name: resource.error ? undefined : resource.title,
            default: subject === drive,
            ...(resource.error ? { error: resource.error.message } : {}),
          };
        }),
      );
    }),
  );

  mcp.registerTool(
    'get_resource',
    {
      title: 'Read resources',
      description:
        'Read one or more resources by subject (or #ref). Returns compact JSON-AD with a one-line `_schema` per class, and for documents and meetings their text as `_documentText`. Children of a folder or drive can be found with query (where parent = subject) or search.',
      inputSchema: {
        subjects: z
          .array(z.string())
          .min(1)
          .describe('Subjects or #refs of the resources to read.'),
        includeCommitData: z
          .boolean()
          .optional()
          .describe('Include the last commit (author and time).'),
      },
      annotations: { readOnlyHint: true },
    },
    withAccess(async ({ subjects, includeCommitData }) => {
      const result: Record<string, unknown> = {};

      for (const subjectOrRef of subjects) {
        try {
          const entry = await readResourceCompact(store, subjectOrRef, {
            includeCommitData,
          });
          const resource = await store.getResource(expandSubject(subjectOrRef));
          const loro = resource.getLoroDoc();

          if (hasDocumentBody(resource.getClasses()) && loro) {
            entry._documentText = documentText(loro);
          }

          result[resource.subject] = entry;
        } catch (error) {
          result[subjectOrRef] = `Error: ${(error as Error).message}`;
        }
      }

      return result;
    }),
  );

  mcp.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Full-text search for resources by words in their name, description or other text. Scoped to the default drive unless `parents` is given.',
      inputSchema: {
        query: z.string().describe('Words to search for.'),
        parents: z
          .array(z.string())
          .optional()
          .describe('Drives or folders to search in (subjects or #refs).'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    withAccess(({ query, parents, limit }, { drive }) =>
      textSearch(store, query, { parents: parents ?? [drive], limit }),
    ),
  );

  mcp.registerTool(
    'semantic_search',
    {
      title: 'Semantic search',
      description:
        'Search by meaning rather than exact words. Returns the first matching chunk of each resource. Needs a server with embeddings enabled; fall back to search if it errors.',
      inputSchema: {
        query: z.string().describe('What you are looking for.'),
        text_query: z
          .string()
          .optional()
          .describe('Exact words to bias the results towards.'),
        parents: z.array(z.string()).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    withAccess(({ query, text_query, parents, limit }, { drive }) =>
      semanticSearch(store, query, {
        parents: parents ?? [drive],
        limit,
        textQuery: text_query,
      }),
    ),
  );

  mcp.registerTool(
    'query',
    {
      title: 'Query by property',
      description:
        'Find resources with specific property values, like a SQL WHERE. With `class` set, where/select take property shortnames and tag names (e.g. class: "task", where: [{property: "status", value: "done"}]) and an isA filter is added. Without `class`, properties must be full URLs, e.g. where: [{property: "https://atomicdata.dev/properties/parent", value: "did:ad:…"}] lists the children of a folder. Results are not sorted.',
      inputSchema: {
        class: z.string().optional(),
        where: z.array(
          z.object({
            property: z.string(),
            value: z.union([
              z.string(),
              z.number(),
              z.boolean(),
              z.array(z.string()),
            ]),
          }),
        ),
        select: z
          .array(z.string())
          .optional()
          .describe('Properties to include. Defaults to name.'),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    withAccess((args, { drive }) =>
      queryResources(store, drive, {
        ...args,
        where: args.where.map(({ property, value }) => ({
          property,
          value: value as JSONValue,
        })),
      }),
    ),
  );

  mcp.registerTool(
    'get_user_classes',
    {
      title: 'List classes',
      description:
        'List the classes (custom types, like "task" or "deal") defined on the default drive.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    withAccess((_args: Record<string, never>, { drive }) =>
      listDriveClasses(store, drive),
    ),
  );

  mcp.registerTool(
    'get_schema',
    {
      title: 'Get class schema',
      description:
        'The required and recommended properties of a class, with their shortnames and datatypes.',
      inputSchema: {
        subject: z
          .string()
          .describe(
            'The class: a name such as "document" or "task", a subject or a #ref.',
          ),
      },
      annotations: { readOnlyHint: true },
    },
    withAccess(async ({ subject }, { drive }) =>
      toClassObject(await resolveClass(store, drive, subject), store),
    ),
  );

  if (!allowWrites) {
    return mcp;
  }

  mcp.registerTool(
    'edit_resource',
    {
      title: 'Edit a property',
      description:
        'Set one property on a resource and save it. `property` is a shortname from the resource\'s schema (e.g. "status") or a full property URL; select values take tag names, dates take ISO strings. To replace the text of a document or meeting, use property "_documentText" with Markdown or plain text (headings, lists, task lists, code blocks, **bold**, *italic*, `code`, links); it overwrites the whole body, so read `_documentText` with get_resource first when keeping parts of it.',
      inputSchema: {
        subject: z.string(),
        property: z.string(),
        value: z.union([
          z.string(),
          z.number(),
          z.boolean(),
          z.array(z.string()),
        ]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withAccess(async ({ subject, property, value }) => {
      if (BODY_KEYS.includes(property)) {
        if (typeof value !== 'string') {
          throw new Error(
            `${property} takes Markdown or plain text as a string.`,
          );
        }

        const resource = await store.getResource(expandSubject(subject));

        if (resource.error) throw new Error(resource.error.message);

        await saveDocumentText(resource, value);

        return { subject: resource.subject, property: '_documentText' };
      }

      return setResourceProperty(store, subject, property, value);
    }),
  );

  mcp.registerTool(
    'create_resource',
    {
      title: 'Create resources',
      description:
        'Create one or more resources from compact JSON-AD. For a document or meeting, "_documentText" sets its text from Markdown or plain text. Each object needs "@class" (a shortname like "folder", "document", "table", a class from get_user_classes, or a full URL) and "@parent" (a drive, folder or table subject), plus property shortnames as keys, e.g. {"@class": "task", "@parent": "#AbCd1234", "name": "Call Anna", "status": "todo"}. Never pass "@id". Pass an array to create many at once.',
      inputSchema: {
        resources: z.array(z.record(z.string(), z.unknown())).min(1).max(200),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    withAccess(async ({ resources }, { drive }) => {
      const created: string[] = [];
      const errors: string[] = [];
      const resolved: Record<string, string> = {};

      for (const [index, data] of resources.entries()) {
        try {
          const { body, rest } = takeBody(data);

          if (body !== undefined) {
            const cls = await resolveClass(
              store,
              drive,
              String(rest['@class']),
            );

            if (!hasDocumentBody([cls])) {
              throw new Error(
                '_documentText only applies to documents and meetings.',
              );
            }
          }

          const result = await createResourceFromCompact(
            store,
            drive,
            rest as Record<string, JSONValue>,
          );

          if (body !== undefined) {
            await saveDocumentText(
              await store.getResource(result.subject),
              body,
            );
          }

          created.push(result.subject);
          Object.assign(resolved, result.resolved);
        } catch (error) {
          errors.push(`Item ${index}: ${(error as Error).message}`);
        }
      }

      if (created.length === 0) {
        throw new Error(errors.join('\n'));
      }

      return {
        created,
        ...(Object.keys(resolved).length > 0 ? { resolved } : {}),
        ...(errors.length > 0 ? { errors } : {}),
      };
    }),
  );

  mcp.registerTool(
    'delete_resource',
    {
      title: 'Delete a resource',
      description:
        'Delete a resource and everything inside it (a folder deletes its contents). This cannot be undone from here; confirm with the person first unless they clearly asked for it.',
      inputSchema: { subject: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    withAccess(async ({ subject }) => {
      const resource = await store.getResource(expandSubject(subject));

      if (resource.error) {
        throw new Error(resource.error.message);
      }

      if (resource.hasClasses(serverOntology.classes.drive)) {
        throw new Error('Deleting a whole drive is not allowed from MCP.');
      }

      const title = resource.title;
      await resource.destroy();

      return `Deleted ${title} (${shortenSubject(resource.subject)}).`;
    }),
  );

  return mcp;
}
