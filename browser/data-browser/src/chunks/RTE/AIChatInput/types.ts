export type SearchSuggestion =
  | AtomicResourceSuggestion
  | CategorySuggestion
  | MCPResourceSuggestion
  | SkillSuggestion
  | CommandSuggestion;

export type MentionItem =
  | AtomicResourceSuggestion
  | MCPResourceSuggestion
  | SkillSuggestion;

export type AtomicResourceSuggestion = {
  type: 'atomic-resource';
  id: string;
  label: string;
  isA: string[];
};
export type CategorySuggestion = {
  type: 'category';
  id: string;
  label: string;
};

export type MCPResourceSuggestion = {
  type: 'mcp-resource';
  serverId: string;
  label: string;
  id: string;
  mimeType?: string;
};

export type SkillSuggestion = {
  type: 'skill';
  id: string;
  label: string;
  description: string;
};

export type CommandSuggestion = {
  type: 'slash-command';
  id: 'compact' | 'skill' | 'model' | 'agent';
  label: string;
  description: string;
};
