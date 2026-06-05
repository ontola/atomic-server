import { createContext, useContext } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { Resource } from '@tomic/react';

export type AIChangesContextType = {
  changes: string[];
  oldResources: Record<string, Resource>;
  oldDocumentSnapshots: Record<string, JSONContent>;
  reportAIEdit: (originalResource: Resource) => void;
  revertResource: (subject: string) => void;
  acceptChanges: (resource: Resource) => Promise<void>;
};

export const defaultAIChangesValue: AIChangesContextType = {
  changes: [],
  oldResources: {},
  oldDocumentSnapshots: {},
  reportAIEdit: () => {},
  revertResource: () => {},
  acceptChanges: () => Promise.resolve(),
};

export const AIChangesContext = createContext<AIChangesContextType>(
  defaultAIChangesValue,
);

type useAIChangesResult = {
  hasAIChanges: (subject: string) => boolean;
} & AIChangesContextType;

export function useAIChanges(): useAIChangesResult {
  const context = useContext(AIChangesContext);
  const { changes } = context;

  const hasAIChanges = (subject: string) => {
    return changes.includes(subject);
  };

  return {
    ...context,
    hasAIChanges,
  };
}
