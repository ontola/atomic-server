// @wc-ignore-file
import {
  commits,
  core,
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
import { constructOpenURL } from '@helpers/navigation';
import { toClassObject, toClassString } from './atomicSchemaHelpers';

export const TOOL_NAMES = {
  SEMANTIC_SEARCH: 'semantic_search',
  QUERY: 'query',
  GET_ATOMIC_RESOURCE: 'get_atomic_resource',
  READ_FILE_RESOURCE: 'read_file_resource',
  GET_SCHEMA: 'get_schema',
  EDIT_ATOMIC_RESOURCE: 'edit_atomic_resource',
  CHANGE_THEME: 'change_theme',
  NAVIGATE_TO_RESOURCE: 'navigate_to_resource',
  CREATE_RESOURCE: 'create_resource',
} as const;

const toResultObject = (resource: Resource, includeCommitData: boolean) => {
  const props = Object.fromEntries(
    Array.from(resource.getPropVals().entries()).filter(
      ([key]) => includeCommitData || key !== commits.properties.lastCommit,
    ),
  );

  return props;
};

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

async function getClassesOnDrive(
  drive: string,
  store: Store,
): Promise<string[]> {
  return store.search('', {
    filters: {
      [core.properties.isA]: core.classes.class,
    },
    parents: [drive],
    include: true,
    limit: 1000,
  });
}

interface UseAtomicMCPToolsProps {
  onResourceEdited?: (subject: string) => void;
}

export function useAtomicMCPTools({
  onResourceEdited,
}: UseAtomicMCPToolsProps = {}) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { drive } = useSettings();

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
              'A short one sentence description of the query to tell the user what you are doing. For example: "Looking at your todo\'s" or "Searching for data about x',
            ),
          limit: z
            .number()
            .describe('The max number of results to return. Range 1 - 50')
            .default(10),
          parents: z
            .array(z.string())
            .describe(
              "A list of subjects of resources to scope the search to. This should be a list of ancestors of the resources you're looking for.",
            )
            .optional(),
        }),
        execute: async ({ query, limit, parents, text_query }) => {
          if (limit < 1 || limit > 50) {
            throw new Error('Limit must be between 1 and 50');
          }

          const results = await store.semanticSearch(query, {
            limit,
            parents: parents ?? [drive],
            text_query,
          });

          return await Promise.all(
            results.map(async res => {
              const r = await store.getResource(res.subject);

              return {
                subject: res.subject,
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
          'Perform a query based on one or more properties. Use this to find resources with specific values for properties.',
        inputSchema: z.object({
          description: z
            .string()
            .describe(
              'A short one sentence description of the query to tell the user what you are doing. For example: "Looking for todo\'s" or "Searching for data about x',
            ),
          select: z
            .array(z.string())
            .describe(
              'A list of properties to include in the result. Kind of like a SELECT statement in a SQL query. By default only the subject and title are included.',
            )
            .optional(),
          where: z
            .record(z.string(), z.any())
            .describe(
              'A record mapping property subjects to values to filter the results by. For example: {"https://atomicdata.dev/properties/name": "John Doe"} or {"https://atomicdata.dev/properties/isA": "https://atomicdata.dev/classes/Person"}',
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
        }) => {
          const results = await store.search('', {
            filters: where,
            limit,
            include: true,
          });

          const resources = await Promise.all(
            results.map(subject => store.getResource(subject)),
          );

          const props = Array.from(
            new Set([...select, ...Object.values(where)]),
          );

          const result = resources.map(res => {
            const obj: Record<string, unknown> = {
              '@id': res.subject,
            };

            for (const prop of props) {
              const val = res.get(prop);

              if (val) {
                obj[prop] = val;
              }
            }

            return obj;
          });

          return result;
        },
      }),
      [TOOL_NAMES.GET_ATOMIC_RESOURCE]: tool({
        description:
          'Retrieve specific resources from the Atomic Data Database by their subjects',
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
          const resources = await Promise.all(
            subjects.map(s => store.getResource(s)),
          );

          const result = resources.reduce(
            async (acc, res, i) => ({
              ...(await acc),
              [subjects[i]]: {
                ...toResultObject(res, includeCommitData),
                _schema: await Promise.all(
                  res
                    .getClasses()
                    .map(classSubject => toClassString(classSubject, store)),
                ),
              },
            }),
            Promise.resolve({}),
          );

          return result;
        },
        strict: true,
      }),
      [TOOL_NAMES.GET_SCHEMA]: tool({
        description:
          'Get a specific class or all classes and properties on this AtomicServer. You can use this to get info about one or more classes. Useful when creating or editting resources and you need to know what properties to use.',
        inputSchema: z.object({
          subject: z
            .string()
            .optional()
            .describe(
              'The subject of the class to get the schema for. If not provided, all classes will be returned.',
            ),
        }),
        execute: async ({ subject }) => {
          const classes = [];

          if (subject) {
            classes.push(subject);
          } else {
            classes.push(...(await getClassesOnDrive(drive, store)));
          }

          const classObjects = await Promise.all(
            classes.map(async cls => toClassObject(cls, store)),
          );

          return classObjects;
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
          await navigate(constructOpenURL(subject));

          return { success: true, message: `Navigated to resource ${subject}` };
        },
        strict: true,
      }),
    },
    write: {
      [TOOL_NAMES.EDIT_ATOMIC_RESOURCE]: tool({
        description: 'Change a property on a resource',
        inputSchema: z.object({
          subject: z.string().describe('The subject of the resource to edit'),
          property: z
            .string()
            .describe('The subject of the property to change'),
          value: z
            .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
            .describe('The new value of the property'),
        }),
        execute: async ({ subject, property, value }) => {
          const resource = await store.getResource(subject);

          try {
            await resource.set(property, value as JSONValue);

            // Notify parent component about the edited resource
            onResourceEdited?.(subject);

            return `Changed property ${property} on resource ${subject} to ${value}`;
          } catch (error) {
            return `Error changing property ${property} on resource ${subject}: ${error}`;
          }
        },
        strict: true,
      }),
      [TOOL_NAMES.CREATE_RESOURCE]: tool({
        description:
          'Create a new resource. You provide the resource with a JSON-AD string that contains the properties and values of the new resource. Do not include an @id property as this is auto generated by the server. The Objec MUST contain http://atomicdata.dev/properties/isA and http://atomicdata.dev/properties/parent as they are always required.',
        inputSchema: z.object({
          jsonAD: z
            .string()
            .describe(
              `A JSON-AD object containing the data of the new resource, make sure to include an ${core.properties.isA} and a ${core.properties.parent} as they are always required. DO NOT include an @id as this is auto generated.`,
            ),
        }),
        execute: async ({ jsonAD }) => {
          try {
            const data = JSON.parse(jsonAD);

            const foundID = data['@id'];

            if (foundID) {
              throw new Error(
                'Do not include an @id in the JSON-AD, the subject is auto generated',
              );
            }

            const {
              [core.properties.isA]: isA,
              [core.properties.parent]: parent,
              ...propVals
            } = data;

            if (!isA) {
              throw new Error('Missing isA property');
            }

            if (!parent) {
              throw new Error('Missing parent property');
            }

            const resource = await store.newResource({
              parent,
              isA,
              propVals,
            });

            await resource.save();

            await store.notifyResourceManuallyCreated(resource);

            return `Created new resource with subject ${resource.subject}`;
          } catch (err) {
            return `Error creating resource: ${err}`;
          }
        },
        strict: true,
      }),
    },
  };

  // Return just the tools
  return { tools };
}
