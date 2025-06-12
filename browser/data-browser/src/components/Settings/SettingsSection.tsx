import { styled } from 'styled-components';
import { Details, type DetailsProps } from '../Details';
import type { PropsWithChildren, ReactNode } from 'react';
import { useSettingsSearch, SettingsSearchProvider } from './SettingsSearch';
import { useMemo } from 'react';

/** Container for a group of settings sections. Adds top border and resets Details toggle styling. */
export const SettingsGroup = styled.div`
  border-top: 1px solid ${p => p.theme.colors.bg2};

  button[aria-label='collapse'],
  button[aria-label='expand'] {
    height: 1.5em;
    background: transparent !important;
    box-shadow: none !important;
  }
`;

/** A single collapsible settings row with bottom border. */
export const SettingsSectionWrapper = styled.div`
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  padding-block: 0.4rem;
`;

/** Muted label for settings section titles. */
export const SettingsLabel = styled.span`
  font-size: 0.9rem;
  font-weight: 500;
  color: ${p => p.theme.colors.textLight};
`;

/** Padding wrapper for content inside a settings section. */
export const SettingsContent = styled.div`
  padding-block: 0.5rem 1rem;
`;

interface SettingsSectionProps extends Omit<DetailsProps, 'title' | 'open'> {
  /** Label shown as the collapsible title */
  label: string;
  /** Keywords from child sections (matching these shows this section, but children still filter themselves) */
  childSearchKeywords?: string;
}

export function queryMatches(query: string, haystack: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term => haystack.includes(term));
}

/** Extracts text content from React children without rendering them to DOM.
 *  Walks the React element tree and collects string content. */
function extractTextFromChildren(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') return String(node);

  if (Array.isArray(node)) {
    return node.map(extractTextFromChildren).join(' ');
  }

  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props: { children?: ReactNode } }).props;

    return extractTextFromChildren(props.children);
  }

  return '';
}

/** Convenience component: a collapsible settings section with consistent styling.
 *  Integrates with SettingsSearch — hides when non-matching, force-opens when matching.
 *  Automatically indexes the text content of children for search. */
export function SettingsSection({
  label,
  childSearchKeywords,
  children,
  ...detailsProps
}: PropsWithChildren<SettingsSectionProps>) {
  const { query, parentMatched } = useSettingsSearch();
  const isSearching = query.length > 0;

  // Build search haystack from label + children text content
  const childText = useMemo(
    () => extractTextFromChildren(children),
    [children],
  );
  const haystack = `${label} ${childText}`.toLowerCase();

  // Does this section's own content match?
  const ownMatch = isSearching && queryMatches(query, haystack);

  // Does a child keyword match? (section shows, but children still filter)
  const childMatch =
    isSearching &&
    !ownMatch &&
    !!childSearchKeywords &&
    queryMatches(query, childSearchKeywords.toLowerCase());

  // Only set parentMatched for children when this section's OWN content matched
  // (or it was already set by an ancestor). Don't set it for childMatch — let children filter.
  const childContext = useMemo(
    () => ({ query, parentMatched: parentMatched || ownMatch }),
    [query, parentMatched, ownMatch],
  );

  // If searching and nothing matches (own, child, or inherited parent), hide.
  if (isSearching && !ownMatch && !childMatch && !parentMatched) {
    return null;
  }

  return (
    <SettingsSectionWrapper>
      <Details
        noIndent
        title={<SettingsLabel>{label}</SettingsLabel>}
        open={isSearching}
        initialState={isSearching}
        {...detailsProps}
      >
        <SettingsContent>
          <SettingsSearchProvider value={childContext}>
            {children}
          </SettingsSearchProvider>
        </SettingsContent>
      </Details>
    </SettingsSectionWrapper>
  );
}
