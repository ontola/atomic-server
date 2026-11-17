import { styled } from 'styled-components';
import { Details, type DetailsPropsBase } from '../Details';
import type { PropsWithChildren, ReactNode } from 'react';
import { useSettingsSearch, SettingsSearchProvider } from './SettingsSearch';
import { useEffect, useMemo, useRef } from 'react';

/** Container for a group of settings sections. Adds top border and resets Details toggle styling. */
export const SettingsGroup = styled.div`
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

  button[aria-label='collapse'],
  button[aria-label='expand'] {
    width: 1.8rem;
    min-width: 1.8rem;
  }

  &:first-child {
    border-top: 0;
  }

  &:last-child {
    border-bottom: 0;
  }
`;

/** Section headings remain distinct from the controls they contain. */
export const SettingsLabel = styled.span`
  font-size: 0.9rem;
  font-weight: 650;
  color: ${p => p.theme.colors.text};
`;

/** Indentation keeps expanded children visibly inside their section. */
export const SettingsContent = styled.div`
  /* Aligns children with the section label, past the toggle. */
  margin: 0.5rem 0 0.75rem 1.1rem;
  padding: 0.25rem 0 0.25rem 1rem;
  min-width: 0;

  @media (max-width: 600px) {
    padding-inline-start: 0.65rem;
  }
`;

interface SettingsSectionProps extends DetailsPropsBase {
  /** Label shown as the collapsible title */
  label: string;
  /** Target for the page's `?section=`: this section opens and scrolls into view. */
  id?: string;
  /** Keywords from child sections (matching these shows this section, but children still filter themselves) */
  childSearchKeywords?: string;
}

export function queryMatches(query: string, haystack: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term =>
      term === 'ai' ? /\bai\b/.test(haystack) : haystack.includes(term),
    );
}

/** Extracts text content from React children without rendering them to DOM.
 *  Walks the React element tree and collects string content. */
export function extractTextFromChildren(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }

  if (typeof node === 'string' || typeof node === 'number') return String(node);

  if (Array.isArray(node)) {
    return node.map(extractTextFromChildren).join(' ');
  }

  // A nested section indexes and filters itself.
  if (
    typeof node === 'object' &&
    'type' in node &&
    node.type === SettingsSection
  ) {
    return '';
  }

  if (typeof node === 'object' && 'props' in node) {
    const props = (node as { props: { children?: ReactNode; hint?: string } })
      .props;

    return `${extractTextFromChildren(props.children)} ${props.hint ?? ''}`;
  }

  return '';
}

/** Convenience component: a collapsible settings section with consistent styling.
 *  Integrates with SettingsSearch — hides when non-matching, force-opens when matching.
 *  Automatically indexes the text content of children for search. */
export function SettingsSection({
  label,
  id,
  childSearchKeywords,
  children,
  ...detailsProps
}: PropsWithChildren<SettingsSectionProps>) {
  const searchContext = useSettingsSearch();
  const {
    query,
    parentMatched,
    depth = 0,
    openSection,
    setOpenSection,
  } = searchContext;
  const isSearching = query.length > 0;
  const targeted = !!id && searchContext.section === id;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (targeted) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [targeted]);

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

  // Only a match on the section's own label (or an ancestor's) shows all of
  // its settings. A match on content shows the section, and its settings
  // rows (SettingCheckbox, SettingField) then filter themselves.
  const labelMatch = isSearching && queryMatches(query, label.toLowerCase());
  const childContext = useMemo(
    () => ({
      ...searchContext,
      parentMatched: parentMatched || labelMatch,
      depth: depth + 1,
    }),
    [searchContext, parentMatched, labelMatch, depth],
  );

  // If searching and nothing matches (own, child, or inherited parent), hide.
  if (isSearching && !ownMatch && !childMatch && !parentMatched) {
    return null;
  }

  const content = (
    <SettingsSearchProvider value={childContext}>
      {children}
    </SettingsSearchProvider>
  );

  // Only top-level sections fold; inside one, a section is a plain subheading.
  if (depth > 0) {
    return (
      <SubSection ref={ref} id={id}>
        <SettingsLabel as='h3'>{label}</SettingsLabel>
        {content}
      </SubSection>
    );
  }

  return (
    <SettingsSectionWrapper ref={ref} id={id}>
      <Details
        noIndent
        title={<SettingsLabel>{label}</SettingsLabel>}
        {...(setOpenSection
          ? {
              // One open at a time; a search opens every match.
              open: isSearching || openSection === (id ?? label),
              initialState: isSearching || openSection === (id ?? label),
              onStateToggle: (state: boolean) =>
                setOpenSection(state ? (id ?? label) : undefined),
            }
          : {
              open: isSearching || targeted,
              initialState: isSearching || targeted,
            })}
        {...detailsProps}
      >
        <SettingsContent>{content}</SettingsContent>
      </Details>
    </SettingsSectionWrapper>
  );
}

/** A subsection inside an open section: a small heading above its settings. */
const SubSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-block: 0.75rem;

  & + & {
    border-top: 1px solid ${p => p.theme.colors.bg2};
  }

  > ${SettingsLabel} {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    color: ${p => p.theme.colors.textLight};
  }
`;

/** Whether a settings row with this text shows: always, unless a search is
 *  running that neither it nor an enclosing section's label matches. */
export function useSettingVisible(text: string): boolean {
  const { query, parentMatched } = useSettingsSearch();

  return !query || parentMatched || queryMatches(query, text.toLowerCase());
}
