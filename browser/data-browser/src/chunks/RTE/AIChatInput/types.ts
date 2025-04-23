export type SearchSuggestion =
  | AtomicResourceSuggestion
  | CategorySuggestion
  | MCPResourceSuggestion;

export type MentionItem = AtomicResourceSuggestion | MCPResourceSuggestion;

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
