// @wc-ignore-file
import {
  Client,
  commits,
  core,
  dataBrowser,
  server,
  useStore,
  type JSONValue,
  type Resource,
  type Store,
} from '@tomic/react';
import { tool } from 'ai';
import { z } from 'zod';
import { useSettings } from '@helpers/AppSettings';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { useAddToOntology } from '@hooks/useAddToOntology';
import { constructOpenURL } from '@helpers/navigation';
import { buildTableFromSpec } from '@chunks/TablePage/createTableFromSpec';
import {
  expandSubject,
  shortenRefsDeep,
  shortenSubject,
} from '@helpers/subjectRefs';
import { getClassesOnDrive, toClassObject } from './atomicSchemaHelpers';
import { useDocumentEditAgent } from './documentEditAgent';
import { getDocumentContentForAgent } from './getDocumentContentForAgent';
import {
  buildClassContext,
  coerceValueIn,
  compactValueOut,
  describeClassCompact,
  fromCompact,
  resolveKey,
  toCompact,
} from './jsonAdCompact';
import type { AIModelIdentifier } from './types';

export const TOOL_NAMES = {
  SEMANTIC_SEARCH: 'semantic_search',
  QUERY: 'query',
  GET_ATOMIC_RESOURCE: 'get_atomic_resource',
  READ_FILE_RESOURCE: 'read_file_resource',
  GET_SCHEMA: 'get_schema',
  GET_USER_CLASSES: 'get_user_classes',
  EDIT_ATOMIC_RESOURCE: 'edit_atomic_resource',
  EDIT_DOCUMENT_RESOURCE: 'edit_document_resource',
  CHANGE_THEME: 'change_theme',
  NAVIGATE_TO_RESOURCE: 'navigate_to_resource',
  CREATE_RESOURCE: 'create_resource',
  CREATE_TABLE: 'create_table',
  READ_SKILL: 'read_skill',
  READ_SKILL_REFERENCE: 'read_skill_reference',
  CREATE_SKILL: 'create_skill',
} as const;

const getClassesString = async (
  resource: Resource,
  store: Store,
): Promise<string> => {
  const classes = [];

  for await (const cls of resource
    .getClasses()
    .map(async x => store.getResource(x))) {
    classes.push(cls.title);
  }

  return classes.join(', ');
};

interface UseAtomicMCPToolsProps {
  onResourceEdited?: (originalResource: Resource) => void;
  editModel: AIModelIdentifier;
}

export function useAtomicMCPTools({
  onResourceEdited,
  editModel,
}: UseAtomicMCPToolsProps) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const addToOntology = useAddToOntology();
  const { drive } = useSettings();
  const runDocumentEdit = useDocumentEditAgent(editModel);

  /** Resolves a `@class` shortname (or title) to a class subject on the
   *  current drive. Full URLs and `#refs` pass through/expand. */
  const resolveClass = async (nameOrRef: string): Promise<string> => {
    const nameOrSubject = expandSubject(nameOrRef);

    if (Client.isValidSubject(nameOrSubject)) {
      return nameOrSubject;
    }

    const classSubjects = await getClassesOnDrive(drive, store);
    const wanted = nameOrSubject.toLowerCase();
    const matches: string[] = [];

    for (const subject of classSubjects) {
      const resource = await store.getResource(subject);
      const shortname = resource.get(core.properties.shortname) as
        | string
        | undefined;

      if (
        shortname?.toLowerCase() === wanted ||
        resource.title.toLowerCase() === wanted
      ) {
        matches.push(subject);
      }
    }

    if (matches.length === 1) {
      return matches[0];
    }

    if (matches.length > 1) {
      throw new Error(
        `Ambiguous class "${nameOrSubject}": ${matches.join(', ')}. Use the full class URL.`,
      );
    }

    throw new Error(
      `Unknown class "${nameOrSubject}". Use get_user_classes to list available classes, or pass a full class URL.`,
    );
  };

  const tools = {
    read: {
      [TOOL_NAMES.SEMANTIC_SEARCH]: tool({
        description:
          'Perform a hybrid semantic and/or text search for resources in the AtomicServer Database. This is more powerful than regular search as it understands the meaning of the query. The results only include the **first** relevant chunk of the resource that matches the query. To get a complete picture you might need to fetch the full resource. If your search requires more specific results use the optional text_query parameter to bias the results towards the text',
        inputSchema: z.object({
          query: z.string().describe('A semantic text query to search for.'),
          text_query: z
            .string()
            .optional()
            .describe(
              "Additional text query to bias the search towards resources containing this text. Useful for searching through code or looking for specific names or id's",
            ),
          description: z
            .string()
            .describe(
              'A short one sentence description of the query to tell the user what you are doing. For example: "Looking at your todo\'s" or "Searching for x',
            ),
          limit: z
            .number()
            .describe('The max number of results to return. Range 1 - 50')
            .default(10),
          parents: z
            .array(z.string())
            .describe(
              "A list of subjects of resources to scope the search to. This should be a list of ancestors of the resources you're looking for. Only use this parameter if you are looking in a specific drive or folder.",
            )
            .optional(),
        }),
        execute: async ({ query, limit, parents, text_query }) => {
          if (limit < 1 || limit > 50) {
            throw new Error('Limit must be between 1 and 50');
          }

          const results = await store.semanticSearch(query, {
            limit,
            parents:
              parents && parents.length !== 0
                ? parents.map(expandSubject)
                : [drive],
            text_query,
          });

          return await Promise.all(
            results.map(async res => {
              const r = await store.getResource(res.subject);

              return {
                subject: shortenSubject(res.subject),
                title: r.title,
                classes: await getClassesString(r, store),
                chunk: res.chunk,
              };
            }),
          );
        },
        strict: true,
      }),
      [TOOL_NAMES.QUERY]: tool({
        description:
          'Perform a query based on one or more properties. Use this to find resources with specific values for properties. When you pass `class`, the where/select entries accept compact property shortnames and tag names (e.g. class: "deal", where: [{property: "status", value: "Lead"}]) and an isA filter is added automatically. Without `class`, properties must be full URLs. **NOTE**: The results are not sorted!',
        inputSchema: z.object({
          description: z
            .string()
            .describe(
              'A short one sentence description of the query to tell the user what you are doing. For example: "Looking for todo\'s" or "Searching for data about x',
            ),
          class: z
            .string()
            .optional()
            .describe(
              'Class to query instances of, as a shortname (e.g. "deal") or full URL. Scopes shortname resolution for where/select and adds the isA filter.',
            ),
          select: z
            .array(z.string())
            .describe(
              'A list of properties to include in the result. Kind of like a SELECT statement in a SQL query. By default only the subject and title are included. Shortnames allowed when `class` is set.',
            )
            .optional(),
          where: z
            .array(z.object({ property: z.string(), value: z.any() }))
            .describe(
              'A list of query filters. With `class` set, use shortnames and tag names: [{property: "status", value: "Lead"}]. Otherwise use full property URLs: [{property: "https://atomicdata.dev/properties/name", value: "John Doe"}]',
            ),
          limit: z
            .number()
            .describe('The max number of results to return. Default is 30.')
            .default(30),
        }),
        execute: async ({
          select = [
            core.properties.name,
            core.properties.shortname,
            server.properties.filename,
          ],
          where,
          limit,
          class: classRef,
        }) => {
          try {
            const classSubject = classRef
              ? await resolveClass(classRef)
              : undefined;
            const ctx = classSubject
              ? await buildClassContext(store, [classSubject])
              : undefined;

            const whereObj: Record<string, string | number | string[]> = {};
            const filterProps: string[] = [];

            for (const { property, value } of where) {
              if (!ctx && !Client.isValidSubject(property)) {
                return `Error: Invalid property subject in where clause: '${property}'. Pass \`class\` to use shortnames.`;
              }

              const info = ctx
                ? resolveKey(ctx, property)
                : { subject: property, shortname: property, datatype: '' };
              const coerced = coerceValueIn(info, value as JSONValue);
              // The query index matches array membership on scalars.
              whereObj[info.subject] = (
                Array.isArray(coerced) && coerced.length === 1
                  ? coerced[0]
                  : coerced
              ) as string | number | string[];
              filterProps.push(info.subject);
            }

            if (classSubject) {
              whereObj[core.properties.isA] = classSubject;
            }

            const results = await store.search('', {
              filters: whereObj,
              limit,
              include: true,
            });

            const resources = await Promise.all(
              results.map(subject => store.getResource(subject)),
            );

            const selectProps = ctx
              ? select.map(s => resolveKey(ctx, s).subject)
              : select;
            const props = Array.from(new Set([...selectProps, ...filterProps]));

            return shortenRefsDeep(
              resources.map(res => {
                const obj: Record<string, unknown> = {
                  '@id': res.subject,
                };

                for (const prop of props) {
                  const val = res.get(prop);

                  if (val) {
                    const info = ctx?.bySubject.get(prop);
                    obj[info?.shortname ?? prop] = info
                      ? compactValueOut(info, val as JSONValue)
                      : val;
                  }
                }

                return obj;
              }),
            );
          } catch (error) {
            return `Error running query: ${error}`;
          }
        },
      }),
      [TOOL_NAMES.GET_ATOMIC_RESOURCE]: tool({
        description:
          'Retrieve specific resources from the Atomic Data Database by their subjects. Returns compact JSON-AD: shortname keys, tag values by name, plus a one-line `_schema` signature per class — the same compact form the write tools accept.',
        inputSchema: z.object({
          subjects: z
            .array(z.string())
            .describe('List of subjects (URL) of the resources to retrieve'),
          includeCommitData: z
            .boolean()
            .describe(
              'Whether to include commit subject in the result. a commit includes the author, and timestamp.',
            ),
        }),
        execute: async ({
          subjects,
          includeCommitData,
        }: {
          subjects: string[];
          includeCommitData: boolean;
        }) => {
          try {
            const result: Record<string, unknown> = {};

            for (const subjectOrRef of subjects) {
              const subject = expandSubject(subjectOrRef);
              const res = await store.getResource(subject);

              if (res.error) {
                result[subject] = `Error: ${res.error.message}`;
                continue;
              }

              const classes = res.getClasses();
              const ctx = await buildClassContext(store, classes);
              const compact = await toCompact(store, res, {
                includeCommitData,
                context: ctx,
              });

              const entry: Record<string, unknown> = compact;

              if (res.hasClasses(dataBrowser.classes.documentV2)) {
                // The raw document body is Loro state; replace it with the
                // agent-readable text, same as the old result shape did.
                const contentInfo = ctx.bySubject.get(
                  dataBrowser.properties.documentContent,
                );
                delete entry[dataBrowser.properties.documentContent];

                if (contentInfo) {
                  delete entry[contentInfo.shortname];
                }

                const content = getDocumentContentForAgent(res, store);
                entry._documentContent = content.ok ? content.text : null;

                if (!content.ok) {
                  entry._documentContentError = content.error;
                }
              }

              entry._schema = classes.map(c => describeClassCompact(ctx, c));
              result[subject] = entry;
            }

            return shortenRefsDeep(result);
          } catch (error) {
            return `Error getting atomic resource: ${error}`;
          }
        },
        strict: true,
      }),
      [TOOL_NAMES.GET_SCHEMA]: tool({
        description:
          'Get the schema of a specific class on this AtomicServer, including its properties. Useful when creating or editting resources and you need to know what properties to use.',
        inputSchema: z.object({
          subject: z
            .string()
            .describe('The subject of the class to get the schema for.'),
        }),
        execute: async ({ subject }) => {
          try {
            return shortenRefsDeep(
              await toClassObject(expandSubject(subject), store),
            );
          } catch (error) {
            return `Error getting schema: ${error}`;
          }
        },
        strict: true,
      }),
      [TOOL_NAMES.GET_USER_CLASSES]: tool({
        description:
          'List all classes defined on the current drive. Returns each class as `<shortname>: <subject>`. Use this to discover available classes, then call `get_schema` for details on a specific class.',
        inputSchema: z.object({}),
        execute: async () => {
          const classSubjects = await getClassesOnDrive(drive, store);

          return await Promise.all(
            classSubjects.map(async cls => {
              const resource = await store.getResource(cls);

              return {
                shortname: resource.title,
                subject: shortenSubject(cls),
              };
            }),
          );
        },
        strict: true,
      }),
      // [TOOL_NAMES.READ_FILE_RESOURCE]: tool({
      //   description: 'Read the contents of a file resource',
      //   inputSchema: z.object({
      //     subject: z
      //       .string()
      //       .describe('The subject of the file resource to read'),
      //   }),
      //   execute: async ({ subject }) => {
      //     const resource = await store.getResource(subject);

      //     if (resource.error) {
      //       return `Error reading ${resource.subject}: ${resource.error.message}`;
      //     }

      //     if (!resource.hasClasses(server.classes.file)) {
      //       return `Error: Resource ${resource.subject} does not have a file class`;
      //     }

      //     const downloadUrl = resource.get(server.properties.downloadUrl);

      //     if (!downloadUrl) {
      //       return `Error: Resource ${resource.subject} does not have a download URL`;
      //     }

      //     const mimetype = resource.get(server.properties.mimetype) as string;

      //     try {
      //       const response = await fetch(downloadUrl, {
      //         headers: { Accept: mimetype },
      //       });

      //       const buffer = await response.arrayBuffer();

      //       return [
      //         {
      //           type: 'text',
      //           text: `Read file ${resource.title || subject}`,
      //         },
      //         {
      //           type: 'media',
      //           data: buffer,
      //           mediaType: mimetype || 'application/octet-stream',
      //         },
      //       ];
      //     } catch (error) {
      //       return `Error reading ${resource.subject}: ${error}`;
      //     }
      //   },
      //   strict: true,
      // }),
      [TOOL_NAMES.NAVIGATE_TO_RESOURCE]: tool({
        description: 'Navigates the user to a resource',
        inputSchema: z.object({
          subject: z
            .string()
            .describe('The subject of the resource to navigate to'),
        }),
        execute: async ({ subject }) => {
          try {
            await navigate(constructOpenURL(expandSubject(subject)));

            return {
              success: true,
              message: `Navigated to resource ${subject}`,
            };
          } catch (error) {
            return `Error navigating to ${subject}: ${error}`;
          }
        },
        strict: true,
      }),
    },
    write: {
      [TOOL_NAMES.EDIT_ATOMIC_RESOURCE]: tool({
        description:
          'Change a property on a resource. The property accepts a compact shortname (resolved against the resource\'s class, e.g. "status") or a full property URL. Select/tag values accept tag names.',
        inputSchema: z.object({
          subject: z.string().describe('The subject of the resource to edit'),
          property: z
            .string()
            .describe(
              'The property to change: a shortname from the resource schema, or a full property URL',
            ),
          value: z
            .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
            .describe('The new value of the property'),
        }),
        execute: async ({ subject: subjectOrRef, property, value }) => {
          let subject = subjectOrRef;

          try {
            subject = expandSubject(subjectOrRef);
          } catch (error) {
            return `Error changing property ${property} on resource ${subjectOrRef}: ${error}`;
          }

          const resource = await store.getResource(subject);
          const originalResource = resource.clone();

          try {
            const ctx = await buildClassContext(store, resource.getClasses());
            const info = resolveKey(ctx, property);
            const coerced = coerceValueIn(info, value as JSONValue);

            await resource.set(info.subject, coerced);

            // Notify parent component about the edited resource
            onResourceEdited?.(originalResource);

            const propertyEcho =
              info.subject === property
                ? property
                : `${property} (${info.subject})`;

            return `Changed property ${propertyEcho} on resource ${subject} to ${JSON.stringify(coerced)}`;
          } catch (error) {
            return `Error changing property ${property} on resource ${subject}: ${error}`;
          }
        },
        strict: true,
      }),
      [TOOL_NAMES.EDIT_DOCUMENT_RESOURCE]: tool({
        description: `Use this tool to instruct edits to a document-v2 resource.

The current document body is available from \`get_atomic_resource\` as \`_documentContent\` (TipTap XML). Use that as the source of truth for existing text and structure.

A simple model will use it to apply the edit to the document. You should make it clear what the edit is but still make sure not to write too much unchanged text.
The edit should be specified using an XML like syntax: include context in a \`<unchanged-text>\` tag, and the change in an \`<edit>\` tag.

For example:

\`\`\`xml
<unchanged-text>
The following points need addressing:
  - No more breaks longer than 20 minutes.
</unchanged-text>
<edit type="block">
  - Add a new section on the topic of "Remote work".
</edit>
\`\`\`

If you are editing text in multiple places you can add multiple \`<edit>\` elements but each edit element should always be preceded by a \`<unchanged-text>\` element that contains the unchanged text.
When you are appending something to a line use the \`type="inline"\` attribute on the \`<edit>\` element, otherwise use \`type="block"\`.
Try to repeat as few lines of the unchanged text as possible to convey the change.
However there should be enough unchanged text to help the smaller model figure out where the edit should be applied.
NEVER omit spans of pre-existing text without using the \`<unchanged-text>\` element to indicate their absence. If you do, the smaller model may delete these lines.`,
        inputSchema: z.object({
          subject: z
            .string()
            .describe('The subject of the document resource to edit'),
          instruction: z
            .string()
            .describe(
              "A single sentence instruction describing what you are going to do for the sketched edit. This is used to assist the less intelligent model in applying the edit. Please use the first person to describe what I am going to do. Don't repeat what I have said previously in normal messages. And use it to disambiguate uncertainty in the edit.",
            ),
          edit: z
            .string()
            .describe(
              'Specify ONLY the precise lines of text that you wish to edit. **NEVER specify or write out unchanged text**. Instead, represent all unchanged text using the `<unchanged-text>` element.',
            ),
        }),
        execute: async ({ subject: subjectOrRef, instruction, edit }) => {
          let subject = subjectOrRef;

          try {
            subject = expandSubject(subjectOrRef);
          } catch (error) {
            return `Error editing document ${subjectOrRef}: ${error}`;
          }

          const resource = await store.getResource(subject);
          const originalResource = resource.clone();

          try {
            const result = await runDocumentEdit(
              subject,
              instruction,
              edit,
              () => onResourceEdited?.(originalResource),
            );

            if (result.startsWith('Error:')) {
              return result;
            }

            return result;
          } catch (error) {
            return `Error editing document ${subject}: ${error}`;
          }
        },
        strict: true,
      }),
      [TOOL_NAMES.CREATE_RESOURCE]: tool({
        description:
          'Create one or more new resources from compact JSON-AD. Provide one object, or an ARRAY of objects to create many resources (e.g. table rows) in a single call — always prefer one batched call over multiple calls. Each object needs "@class" (class shortname or URL) and "@parent" (subject), plus property shortnames as keys, e.g. {"@class": "deal", "@parent": "did:ad:…", "name": "Acme", "status": "Lead"}. Full property URLs also work as keys. DO NOT include an @id, it is auto generated.',
        inputSchema: z.object({
          jsonAD: z
            .string()
            .describe(
              'A compact JSON-AD object, or an array of them to create multiple resources at once. Each must include "@class" and "@parent". DO NOT include an @id as this is auto generated.',
            ),
        }),
        execute: async ({ jsonAD }) => {
          const createOne = async (data: Record<string, JSONValue>) => {
            const { isA, parent, propVals, resolved } = await fromCompact(
              store,
              data,
              { resolveClass },
            );

            const parentResource = await store.getResource(parent);

            if (parentResource.hasClasses(dataBrowser.classes.table)) {
              // The parent is a table meaning the resource that is being created is a row. We should add a createdAt property to it.
              propVals[commits.properties.createdAt] ??= Date.now();
            }

            const resource = await store.newResource({
              parent,
              isA,
              propVals,
            });

            await resource.save();

            if (
              !parentResource.hasClasses(core.classes.ontology) &&
              !parentResource.hasClasses(dataBrowser.classes.table)
            ) {
              // Notify the store that we created a resource but not if the parent is an ontology or table as in that case we don't want them to show in the sidebar.
              await store.notifyResourceManuallyCreated(resource);
            }

            return { subject: resource.subject, resolved };
          };

          let data: unknown;

          try {
            data = JSON.parse(jsonAD);
          } catch (err) {
            return `Error creating resource: ${err}`;
          }

          if (!Array.isArray(data)) {
            try {
              const { subject, resolved } = await createOne(
                data as Record<string, JSONValue>,
              );

              // The echoed resolution map makes silent misresolution visible.
              // The subject stays at the very end of the message; callers
              // parse it from there.
              const resolvedLine =
                Object.keys(resolved).length > 0
                  ? `Resolved properties: ${JSON.stringify(resolved)}\n`
                  : '';

              return `${resolvedLine}Created new resource with subject ${shortenSubject(subject)}`;
            } catch (err) {
              return `Error creating resource: ${err}`;
            }
          }

          const created: string[] = [];
          const errors: string[] = [];
          const resolved: Record<string, string> = {};

          for (const [index, item] of data.entries()) {
            try {
              const result = await createOne(item as Record<string, JSONValue>);
              created.push(shortenSubject(result.subject));
              Object.assign(resolved, result.resolved);
            } catch (err) {
              errors.push(`Item ${index}: ${err}`);
            }
          }

          return {
            created,
            ...(Object.keys(resolved).length > 0 ? { resolved } : {}),
            ...(errors.length > 0 ? { errors } : {}),
          };
        },
        strict: true,
      }),
      [TOOL_NAMES.CREATE_TABLE]: tool({
        description:
          'Create a fully-configured table in ONE call: its row Class, all columns, any saved views (table or kanban), and optionally its initial rows. Prefer this over creating the class, properties, table and rows separately with create_resource. The response contains everything needed for follow-up work — the table subject, and per column its property subject plus (for select columns) each tag option subject — so you never need get_schema afterwards.',
        inputSchema: z.object({
          name: z.string().describe('The display name of the table.'),
          parent: z
            .string()
            .optional()
            .describe(
              'Subject of the folder or drive to create the table in. Defaults to the current drive.',
            ),
          columns: z
            .array(
              z.object({
                name: z
                  .string()
                  .describe('The column (property) display name.'),
                type: z
                  .enum([
                    'text',
                    'markdown',
                    'number',
                    'date',
                    'datetime',
                    'checkbox',
                    'relation',
                    'file',
                    'select',
                  ])
                  .describe(
                    "The column datatype. Use 'select' for an enum/tag column; provide its `options`. Use 'relation' for a link to another resource.",
                  ),
                options: z
                  .array(z.string())
                  .optional()
                  .describe(
                    "For 'select' columns only: the allowed tag options, e.g. ['Todo','Doing','Done'].",
                  ),
                description: z.string().optional(),
              }),
            )
            .describe(
              'The columns of the table. A `name` title column is always added automatically, so do not include it.',
            ),
          views: z
            .array(
              z.object({
                name: z.string(),
                kind: z.enum(['table', 'kanban']),
                groupByColumn: z
                  .string()
                  .optional()
                  .describe(
                    "For 'kanban' views: the name of the 'select' column whose tags become the board columns.",
                  ),
                default: z
                  .boolean()
                  .optional()
                  .describe('Whether this is the view shown by default.'),
              }),
            )
            .optional()
            .describe(
              'Optional saved views. Omit for a plain table with the default view.',
            ),
          rows: z
            .array(z.record(z.string(), z.any()))
            .optional()
            .describe(
              'Optional initial rows to insert, created in this same call. Each row is an object mapping column name → value, plus \'name\' for the row title. For \'select\' columns use the tag option name, e.g. { "name": "Acme Corp", "Status": "Lead" }. Prefer this over separate create_resource calls.',
            ),
        }),
        execute: async ({ name, parent, columns, views, rows }) => {
          try {
            const result = await buildTableFromSpec(
              store,
              { name, columns, views, rows },
              {
                parent: parent ? expandSubject(parent) : drive,
                driveSubject: drive,
                addToOntology,
              },
            );

            const columnsOut: Record<
              string,
              { property: string; tags?: Record<string, string> }
            > = {
              name: { property: core.properties.name },
            };

            for (const [columnName, subject] of Object.entries(
              result.columns,
            )) {
              columnsOut[columnName] = {
                property: subject,
                ...(result.tags[columnName]
                  ? { tags: result.tags[columnName] }
                  : {}),
              };
            }

            const tableRef = shortenSubject(result.tableSubject);
            const classRef = shortenSubject(result.classSubject);

            return shortenRefsDeep({
              table: result.tableSubject,
              class: result.classSubject,
              columns: columnsOut,
              ...(result.rowSubjects.length > 0
                ? { rows: result.rowSubjects }
                : {}),
              addingMoreRows: `Call create_resource with an ARRAY of compact objects (one call for all rows), each with "@parent": "${tableRef}", "@class": "${classRef}", the column names as keys, tag names for select columns, and "name" for the title. createdAt is added automatically. No get_schema needed.`,
            });
          } catch (err) {
            return `Error creating table: ${err}`;
          }
        },
        strict: true,
      }),
    },
  };

  // Return just the tools
  return { tools };
}
