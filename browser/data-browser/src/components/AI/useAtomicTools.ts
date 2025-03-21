import {
  commits,
  core,
  useStore,
  type JSONValue,
  type Resource,
} from '@tomic/react';
import { tool } from 'ai';
import { z } from 'zod';
import { useSettings } from '../../helpers/AppSettings';
import { DarkModeOption } from '../../helpers/useDarkMode';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../helpers/navigation';
import { toClassString } from './atomicSchemaHelpers';

export const TOOL_NAMES = {
  SEARCH_RESOURCE: 'search_resource',
  GET_ATOMIC_RESOURCE: 'get_atomic_resource',
  GET_SCHEMA: 'get_schema',
  EDIT_ATOMIC_RESOURCE: 'edit_atomic_resource',
  CHANGE_THEME: 'change_theme',
  NAVIGATE_TO_RESOURCE: 'navigate_to_resource',
  CREATE_RESOURCE: 'create_resource',
  SHOW_SVG: 'show_svg',
} as const;

const toResultObject = (resource: Resource, includeCommitData: boolean) => {
  const props = Object.fromEntries(
    resource
      .getPropVals()
      .entries()
      .filter(
        ([key]) => includeCommitData || key !== commits.properties.lastCommit,
      ),
  );

  return props;
};

const toSmallResultObject = (resource: Resource) => {
  return Object.fromEntries(
    resource
      .getPropVals()
      .entries()
      .filter(([key]) =>
        (
          [
            core.properties.name,
            core.properties.description,
            core.properties.isA,
            core.properties.parent,
          ] as string[]
        ).includes(key),
      ),
  );
};

interface UseAtomicMCPToolsProps {
  onResourceEdited?: (subject: string) => void;
}

export function useAtomicMCPTools({
  onResourceEdited,
}: UseAtomicMCPToolsProps = {}) {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const { setDarkMode, darkModeSetting } = useSettings();

  const tools = {
    read: {
      [TOOL_NAMES.SEARCH_RESOURCE]: tool({
        description:
          'Search for resources in the Atomic Data Database. Resources are matched based on their title and description. Search results do not include the full resources as JSON-AD, but only the most important properties.',
        parameters: z.object({
          query: z.string().describe('A text query to search for.'),
          limit: z
            .number()
            .describe('The max number of results to return. Range 1 - 50')
            .default(10),
        }),
        execute: async ({ query, limit }) => {
          if (limit < 1 || limit > 50) {
            throw new Error('Limit must be between 1 and 50');
          }

          const results = await store.search(query, { limit });

          const resources = await Promise.all(
            results.map(subject => store.getResource(subject)),
          );

          const result = resources.reduce(
            (acc, res, i) => ({
              ...acc,
              [results[i]]: toSmallResultObject(res),
            }),
            {},
          );

          return result;
        },
      }),
      [TOOL_NAMES.GET_ATOMIC_RESOURCE]: tool({
        description:
          'Retrieve specific resources from the Atomic Data Database by their subjects',
        parameters: z.object({
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

          return JSON.stringify(await result, null, 2);
        },
      }),
      [TOOL_NAMES.NAVIGATE_TO_RESOURCE]: tool({
        description: 'Navigates the user to a resource',
        parameters: z.object({
          subject: z
            .string()
            .describe('The subject of the resource to navigate to'),
        }),
        execute: async ({ subject }) => {
          await navigate(constructOpenURL(subject));

          return `Navigated to resource ${subject}`;
        },
      }),
      [TOOL_NAMES.SHOW_SVG]: tool({
        description:
          "Show an SVG image to the user. The svg will be shown so you don't have to tell the user the exact svg code afterwards.",
        parameters: z.object({
          svg: z.string().describe('The SVG code to show'),
        }),
        execute: async ({ svg }) => {
          return {
            message:
              'Success, the user can now see the svg, no need to tell them the exact svg code',
            data: svg,
          };
        },
      }),
    },
    write: {
      [TOOL_NAMES.EDIT_ATOMIC_RESOURCE]: tool({
        description: 'Change a property on a resource',
        parameters: z.object({
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
      }),
      [TOOL_NAMES.CHANGE_THEME]: tool({
        description: 'Change the visual theme of the Atomic Data Browser',
        parameters: z.object({
          theme: z.enum(['light', 'dark', 'system']),
        }),
        execute: async ({ theme }) => {
          const prevTheme = getThemeName(darkModeSetting);

          switch (theme) {
            case 'light':
              setDarkMode(false);
              break;
            case 'dark':
              setDarkMode(true);
              break;
            case 'system':
              setDarkMode(undefined);
              break;
          }

          return `Changed theme from ${prevTheme} to ${theme}`;
        },
      }),
      [TOOL_NAMES.CREATE_RESOURCE]: tool({
        description:
          'Create a new resource. To create a resource you will need to provide the subject of the class and an object with.',
        parameters: z.object({
          jsonAD: z
            .string()
            .describe(
              `A JSON-AD object containing the data of the new resource, make sure to include an ${core.properties.isA} and a ${core.properties.parent} as they are always required. Do not include an ${core.properties.id} as this is auto generated.`,
            ),
        }),
        execute: async ({ jsonAD }) => {
          console.log('creating resource', jsonAD);

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

            console.log('created resource', resource);

            await resource.save();

            return `Created new resource with subject ${resource.subject}`;
          } catch (err) {
            return `Error creating resource: ${err}`;
          }
        },
      }),
    },
  };

  // Return just the tools
  return { tools };
}

function getThemeName(darkModeSetting: DarkModeOption) {
  switch (darkModeSetting) {
    case DarkModeOption.never:
      return 'light';
    case DarkModeOption.always:
      return 'dark';
    case DarkModeOption.auto:
      return 'system';
  }
}
