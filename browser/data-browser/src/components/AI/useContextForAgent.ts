import { commits, useResource, useStore, type Resource } from '@tomic/react';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { useEffect, useState } from 'react';
import type { AIMessageContext } from './types';
import { toClassString } from './atomicSchemaHelpers';

export type AgentContextData = {
  '{{resource.title}}': string;
  '{{resource.data}}': string;
  '{{resource.schema}}': string;
};

const defaultContextData: AgentContextData = {
  '{{resource.title}}': 'unavailable',
  '{{resource.data}}': 'unavailable',
  '{{resource.schema}}': 'unavailable',
};

export function useContextDataForAgent() {
  const store = useStore();
  // const [currentSubject] = useCurrentSubject();
  // const resource = useResource(currentSubject);

  // const [contextData, setContextData] =
  //   useState<AgentContextData>(defaultContextData);

  // useEffect(() => {
  //   (async () => {
  //     if (resource.error || resource.loading) {
  //       setContextData(defaultContextData);

  //       return;
  //     }

  //     const resourceData = toResultObject(resource, true);
  //     const classString = await toClassString(resource.getClasses()[0], store);

  //     setContextData({
  //       '{{resource.title}}': resource.title,
  //       '{{resource.data}}': JSON.stringify(resourceData, null, 2),
  //       '{{resource.schema}}': classString,
  //     });
  //   })();
  // }, [resource, store]);

  // const injectContextIntoPrompt = (prompt: string) =>
  //   Array.from(Object.entries(contextData)).reduce(
  //     (acc, [key, value]) => acc.replaceAll(key, value),
  //     prompt,
  //   );

  const addContextToMessage = async (
    message: string,
    context: AIMessageContext[],
  ) => {
    const subjects = context
      .filter(x => x.type === 'resource')
      .map(x => x.subject);

    const resources = await Promise.all(
      subjects.map(s => store.getResource(s)),
    );

    const result = resources
      .map(
        r => `An atomic resource called ${r.title}. Data:\n\`\`\`json
${JSON.stringify(toResultObject(r, true), null, 2)}
\`\`\``,
      )
      .join('\n');

    const classes = Array.from(new Set(resources.flatMap(r => r.getClasses())));
    const schemaDefs = await Promise.all(
      classes.map(c => toClassString(c, store)),
    );

    const messageWithContext = `${message}\n<context>\n<resources>\n${result}\n</resources>\n<schemas>\n${schemaDefs.join('\n')}\n</schemas>\n</context>`;

    console.log(messageWithContext);

    return messageWithContext;
  };

  return { addExtraContextToMessage: addContextToMessage };
}

const toResultObject = (resource: Resource, includeCommitData: boolean) => {
  const props = Object.fromEntries(
    Array.from(resource.getPropVals().entries()).filter(
      ([key]) => includeCommitData || key !== commits.properties.lastCommit,
    ),
  );

  return {
    '@id': resource.subject,
    ...props,
  };
};
