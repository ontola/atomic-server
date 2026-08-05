import { useEffect, useRef, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { constructOpenURL } from '../../helpers/navigation';
import ResourceCard from '../../views/Card/ResourceCard';
import { dataBrowser, useServerSearch, useStore } from '@tomic/react';
import { ErrorLook } from '../../components/ErrorLook';
import { FaMagnifyingGlass, FaLink } from 'react-icons/fa6';
import { useQueryScopeHandler } from '../../hooks/useQueryScope';
import { useSettings } from '../../helpers/AppSettings';
import { Column, Row } from '../../components/Row';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { base64StringToFilter } from './searchUtils';
import { InlineFormattedResourceList } from '../../components/InlineFormattedResourceList';
import { ErrorBoundary } from '../../views/ErrorPage';
import { useOnValueChange } from '@helpers/useOnValueChange';
import { useSearchOverlay } from '../../components/Searchbar/SearchOverlayContext';
import {
  looksLikeOpenableSubject,
  parseDidOpenInput,
  resolveDidForOpen,
} from '../../helpers/didResolve';

const OverlayBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: ${p => p.theme.zIndex.searchOverlay};
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(6px);
  animation: fadeIn 100ms ease-out;

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
`;

const CommandPalettePanel = styled.div`
  position: fixed;
  top: 15vh;
  left: 50%;
  transform: translateX(-50%);
  z-index: ${p => p.theme.zIndex.searchOverlay};
  width: 100%;
  max-width: 38rem;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  box-shadow: ${p => p.theme.boxShadow};
  animation: slideIn 100ms ease-out;
  overflow: hidden;

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(-50%) translateY(-12px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
`;

const SearchInputWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};

  svg {
    color: ${p => p.theme.colors.textLight};
    flex-shrink: 0;
  }
`;

const SearchInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  color: ${p => p.theme.colors.text};
  font-family: inherit;

  &::placeholder {
    color: ${p => p.theme.colors.textLight};
  }
`;

const ShortcutHint = styled.kbd`
  background: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: 0.25rem;
  padding: 0.1rem 0.35rem;
  font-size: 0.7rem;
  color: ${p => p.theme.colors.textLight};
  font-family: inherit;
`;

const ResultsArea = styled.div`
  flex: 1;
  overflow-y: auto;
  padding: 0.5rem;

  &:empty {
    display: none;
  }
`;

ResultsArea.displayName = 'ResultsArea';

const HeadingRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.875rem 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.875rem;
`;

const HeadingIcon = styled.span`
  display: flex;
  align-items: center;
`;

const TagHeading = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-weight: bold;
`;

const HelperMessage = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.875rem;
  padding: 0.75rem 1rem;
  line-height: 1.5;
`;

const FooterRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
`;

const FooterHints = styled.div`
  display: flex;
  gap: 1rem;

  span {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
`;

/**
 * Command palette overlay — centered, with input built in.
 * Opens via Cmd+K, closes via Escape or backdrop click.
 */
export function SearchOverlay(): JSX.Element | null {
  const { isOpen, closeSearch, inputRef } = useSearchOverlay();

  useEffect(() => {
    if (isOpen && inputRef.current) {
      // Small delay to let animation start first
      const timer = setTimeout(() => inputRef.current?.focus(), 50);

      return () => clearTimeout(timer);
    }
  }, [isOpen, inputRef.current]);

  if (!isOpen) {
    return null;
  }

  return (
    <>
      <OverlayBackdrop onClick={closeSearch} />
      <CommandPalettePanel onClick={e => e.stopPropagation()}>
        <SearchOverlayContent closeSearch={closeSearch} />
      </CommandPalettePanel>
    </>
  );
}

function SearchOverlayContent({
  closeSearch,
}: {
  closeSearch: () => void;
}): JSX.Element {
  const {
    query,
    filters: filtersBase64,
    setQuery,
    inputRef,
  } = useSearchOverlay();
  const { drive } = useSettings();
  const { scope } = useQueryScopeHandler();
  const navigate = useNavigateWithTransition();
  const store = useStore();

  const filters = filtersBase64 ? base64StringToFilter(filtersBase64) : {};
  const filterIsEmpty = Object.keys(filters).length === 0;
  const tags = (filters[dataBrowser.properties.tags] as string[]) ?? [];

  const didTarget = parseDidOpenInput(query);
  const showDidOpen = didTarget !== null || looksLikeOpenableSubject(query);

  const [selectedIndex, setSelected] = useState(0);
  const [resolvingDid, setResolvingDid] = useState(false);
  const { results, loading, error } = useServerSearch(query, {
    debounce: 0,
    parents: scope || drive,
    include: true,
    filters,
    allowEmptyQuery: !filterIsEmpty,
  });

  // DID open row sits above search hits when the query is a subject.
  const didRowOffset = showDidOpen ? 1 : 0;
  const totalRows = results.length + didRowOffset;

  const resultsRef = useRef<HTMLDivElement | null>(null);

  // Sync query from context into the input
  useEffect(() => {
    if (inputRef.current && inputRef.current.value !== query) {
      inputRef.current.value = query;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, inputRef.current]);

  // Reset selection when results change
  useOnValueChange(() => {
    setSelected(0);
  }, [results, showDidOpen]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelected(0);
  };

  const openDidTarget = async () => {
    const target = didTarget ?? parseDidOpenInput(query.trim());

    if (!target) {
      return;
    }

    setResolvingDid(true);

    try {
      await resolveDidForOpen(target.subject, {
        drive,
        agent: target.agent,
        node: target.node,
        // Auto-try known devices when the link has no node/agent hint.
        tryPeers: !target.node && !target.agent,
        isAvailable: async subject => {
          try {
            const resource = await store.getResource(subject);

            return !resource.error;
          } catch {
            return false;
          }
        },
      });
    } finally {
      setResolvingDid(false);
    }

    (document.activeElement as HTMLInputElement | null)?.blur();
    navigate(constructOpenURL(target.subject));
    closeSearch();
  };

  const handleSelectResult = () => {
    if (showDidOpen && selectedIndex === 0) {
      void openDidTarget();

      return;
    }

    const selectedSubject = results[selectedIndex - didRowOffset];

    if (selectedSubject) {
      (document.activeElement as HTMLInputElement | null)?.blur();
      const openURL = constructOpenURL(selectedSubject);
      navigate(openURL);
      closeSearch();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(prev =>
          totalRows === 0 ? 0 : Math.min(prev + 1, totalRows - 1),
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(prev => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();
        handleSelectResult();
        break;
      case 'Escape':
        e.preventDefault();
        closeSearch();
        break;
    }
  };

  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const selectedEl = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      ) as HTMLElement | null;
      selectedEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  let heading: string | undefined = 'No hits';

  if (!query && filterIsEmpty) {
    heading = undefined;
  }

  if (showDidOpen) {
    heading = undefined;
  }

  if (loading || resolvingDid) {
    heading = resolvingDid ? 'Resolving DID…' : 'Searching...';
  }

  const showHelperMessage = !query && filterIsEmpty;

  return (
    <ErrorBoundary>
      <SearchInputWrapper>
        <FaMagnifyingGlass size={16} />
        <SearchInput
          ref={inputRef}
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder='Search or paste a did:ad:…'
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
        />
        <ShortcutHint onClick={closeSearch}>esc</ShortcutHint>
      </SearchInputWrapper>

      {error ? (
        <ErrorLook style={{ padding: '1rem' }}>{error.message}</ErrorLook>
      ) : (
        <>
          {heading && (
            <HeadingRow>
              <HeadingIcon>
                <FaMagnifyingGlass size={12} />
              </HeadingIcon>
              {heading}
            </HeadingRow>
          )}

          {tags.length > 0 && (
            <Row
              center
              gap='1ch'
              style={{ padding: '0.5rem 1rem', borderBottom: '1px solid' }}
            >
              <TagHeading>With Tags:</TagHeading>
              <span>
                <InlineFormattedResourceList subjects={tags} />
              </span>
            </Row>
          )}

          {showHelperMessage && (
            <HelperMessage>
              Search matches on the names and descriptions of resources. Paste a{' '}
              <code>did:ad:</code> identifier to open it. Filter by tag with{' '}
              <code>tag:[name]</code>
            </HelperMessage>
          )}

          <ResultsArea ref={resultsRef}>
            <Column gap='0.5rem'>
              {showDidOpen && didTarget && (
                <DidOpenRow
                  data-index={0}
                  selected={selectedIndex === 0}
                  onClick={() => {
                    setSelected(0);
                    void openDidTarget();
                  }}
                >
                  <FaLink size={14} />
                  <div>
                    <DidOpenTitle>Open DID</DidOpenTitle>
                    <DidOpenSubject title={didTarget.subject}>
                      {didTarget.subject}
                    </DidOpenSubject>
                    {!didTarget.node && !didTarget.agent && (
                      <DidOpenHint>
                        No node hint — will try known devices if needed
                      </DidOpenHint>
                    )}
                  </div>
                </DidOpenRow>
              )}
              {results.map((subject, index) => {
                const rowIndex = index + didRowOffset;

                return (
                  <SelectableResult
                    key={subject}
                    subject={subject}
                    initialInView={index < 5}
                    selected={rowIndex === selectedIndex}
                    index={rowIndex}
                    onClick={() => {
                      setSelected(rowIndex);
                      setTimeout(() => {
                        const openURL = constructOpenURL(subject);
                        navigate(openURL);
                        closeSearch();
                      }, 80);
                    }}
                  />
                );
              })}
            </Column>
          </ResultsArea>

          <FooterRow>
            <FooterHints>
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> open
              </span>
              <span>
                <kbd>esc</kbd> close
              </span>
            </FooterHints>
            {results.length > 0 && (
              <span>
                {results.length} result{results.length !== 1 ? 's' : ''}
              </span>
            )}
          </FooterRow>
        </>
      )}
    </ErrorBoundary>
  );
}

interface SelectableResultProps {
  subject: string;
  initialInView: boolean;
  selected: boolean;
  index: number;
  onClick: () => void;
}

const SelectableResult: React.FC<SelectableResultProps> = ({
  subject,
  initialInView,
  selected,
  index,
  onClick,
}) => {
  const ref = useRef<HTMLDivElement | null>(null);

  return (
    <div
      ref={ref}
      data-index={index}
      style={{
        borderRadius: '0.375rem',
        background: selected ? 'var(--color-bg1)' : 'transparent',
        cursor: 'pointer',
        transition: 'background 80ms',
      }}
    >
      <ResourceCard
        initialInView={initialInView}
        subject={subject}
        highlight={selected}
        onClick={onClick}
      />
    </div>
  );
};

const DidOpenRow = styled.button<{ selected: boolean }>`
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  width: 100%;
  text-align: left;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: 0.375rem;
  padding: 0.75rem 1rem;
  background: ${p =>
    p.selected ? p.theme.colors.bg1 : p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  cursor: pointer;
  font: inherit;

  svg {
    margin-top: 0.2rem;
    flex-shrink: 0;
    color: ${p => p.theme.colors.main};
  }
`;

const DidOpenTitle = styled.div`
  font-weight: 600;
  font-size: 0.9rem;
`;

const DidOpenSubject = styled.div`
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  word-break: break-all;
  margin-top: 0.15rem;
`;

const DidOpenHint = styled.div`
  font-size: 0.7rem;
  color: ${p => p.theme.colors.textLight};
  margin-top: 0.35rem;
`;
