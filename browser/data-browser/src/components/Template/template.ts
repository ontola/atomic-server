import type { JSONValue } from '@tomic/react';

export type TemplateContext = {
  driveURL: string;
};

export type TemplateFn = (context: TemplateContext) => {
  rootResourceLocalIDs: string[];
  id: string;
  title: string;
  description: string;
  Image: React.FC;
  resources: Record<string, JSONValue>[];
};

export type Template = ReturnType<TemplateFn>;
