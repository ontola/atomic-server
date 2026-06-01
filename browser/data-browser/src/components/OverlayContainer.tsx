import { useEffect, useRef, useState, type JSX, useMemo } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { styled } from 'styled-components';
import { shortcuts } from './HotKeyWrapper';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import {
  useServerSearch,
  useStore,
  ai,
  core,
  dataBrowser,
  useArray,
  useResource,
  useResources,
  type Ai,
  type Server,
  type Store,
} from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { useQueryScopeHandler } from '../hooks/useQueryScope';
import { Column, Row } from './Row';
import { ErrorBoundary } from '../views/ErrorPage';
import { ErrorLook } from './ErrorLook';

import { InlineFormattedResourceList } from './InlineFormattedResourceList';
import { FaMagnifyingGlass, FaComments } from 'react-icons/fa6';
import ResourceCard from '../views/Card/ResourceCard';
import ResourceRow from '@views/ResourceRow';

// ─── Module-level overlay state ────────────────────────────────────────────────

type OverlayType = 'search' | 'shortcuts' | null;

const overlayListeners = new Set<(overlay: OverlayType) => void>();

function setOverlay(overlay: OverlayType): void {
  overlayListeners.forEach(listener => listener(overlay));
}

export function openSearchOverlay(_query?: string): void {
  setOverlay('search');
}

export function openShortcutsOverlay(): void {
  setOverlay('shortcuts');
}

export function closeOverlay(): void {
  setOverlay(null);
}

// ─── Module-level search state (shared between SearchOverlay and PreviewPane) ───

let searchResults: string[] = [];
let searchSelectedIndex = 0;
const previewListeners = new Set<
  (isOpen: boolean, results: string[], index: number) => void
>();

export function setSearchResults(results: string[], index: number): void {
  searchResults = results;
  searchSelectedIndex = index;
  previewListeners.forEach(listener =>
    listener(searchResults.length > 0, searchResults, searchSelectedIndex),
  );
}

// ─── Backdrop + Panel ─────────────────────────────────────────────────────────

const OverlayBackdrop = styled.div`
  position: fixed;
  inset: 0;
  z-index: 999;
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

const OverlayPanel = styled.div`
  position: fixed;
  top: 15vh;
  left: 50%;
  transform: translateX(-50%);
  z-index: 999;
  width: 100%;
  max-width: 30rem;
  height: 30rem;
  display: flex;
  flex-direction: column;
  background: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  box-shadow: ${p => p.theme.boxShadow};
  animation: slideIn 100ms ease-out;
  overflow: visible;

  @keyframes slideIn {
    from {
      transform: translate(-50%, -20px);
      opacity: 0;
    }
    to {
      transform: translate(-50%, 0);
      opacity: 1;
    }
  }
`;

const OverlayInputWrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
`;

const OverlayInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  font-size: 1.125rem;
  color: ${p => p.theme.colors.text};
  outline: none;

  &::placeholder {
    color: ${p => p.theme.colors.textLight};
  }
`;

const ShortcutHint = styled.kbd`
  padding: 0.2rem 0.4rem;
  background: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: 0.25rem;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
`;

const PanelContent = styled.div`
  flex: 1;
  overflow-y: auto;
  min-height: 0;
`;

const ResultsList = styled.div`
  display: flex;
  flex-direction: column;
`;

const ResultsArea = styled.div`
  flex: 1;
`;

const TagHeading = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
`;

const FooterRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.75rem;
  background: ${p => p.theme.colors.bg};
  border-bottom-left-radius: inherit;
  border-bottom-right-radius: inherit;
`;

const FooterHints = styled.div`
  display: flex;
  gap: 1rem;

  kbd {
    background: ${p => p.theme.colors.bg1};
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: 0.2rem;
    padding: 0.1rem 0.3rem;
    font-family: inherit;
  }
`;

const PreviewFloat = styled.div`
  position: absolute;
  top: 0;
  right: -1rem;
  transform: translateX(100%);
  z-index: 1000;
  width: 18rem;
  height: 30rem;
  overflow-y: auto;
`;

const AIChatRow = styled.button<{ $selected?: boolean }>`
  display: flex;
  align-items: center;
  width: 100%;
  gap: 0.75rem;
  padding: 0.75rem 1rem;
  border: none;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => (p.$selected ? p.theme.colors.bg1 : 'transparent')};
  color: ${p => p.theme.colors.text};
  font-size: 0.875rem;
  cursor: pointer;
  text-align: left;
  transition: background 80ms;

  &:hover {
    background: ${p => p.theme.colors.bg1};
  }

  span {
    flex: 1;
  }

  svg {
    color: ${p => p.theme.colors.main};
    flex-shrink: 0;
  }
`;

// ─── Search Overlay ────────────────────────────────────────────────────────────

const tagTokenRegex = /\btag:([\w-]+)/g;

function parseSearchTags(
  query: string,
  tagResources: Map<string, { title: string }>,
): { searchQuery: string; tagSubjects: string[] } {
  const tagSubjects = new Set<string>();

  for (const match of query.matchAll(tagTokenRegex)) {
    const tagTitle = match[1].toLowerCase();

    for (const [subject, tag] of tagResources) {
      if (tag.title.toLowerCase() === tagTitle) {
        tagSubjects.add(subject);
        break;
      }
    }
  }

  return {
    searchQuery: query.replace(tagTokenRegex, '').trim(),
    tagSubjects: [...tagSubjects],
  };
}

function SearchOverlay(): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { drive } = useSettings();
  const { scope } = useQueryScopeHandler();
  const navigate = useNavigateWithTransition();
  const store = useStore();
  const driveResource = useResource<Server.Drive>(drive);
  const [driveTags] = useArray(driveResource, dataBrowser.properties.tagList);
  const tagResources = useResources(driveTags);

  const handleStartAIChat = async (
    q: string,
    s: Store,
    d: string,
    n: (url: string) => void,
  ): Promise<void> => {
    const chatResource = await s.newResource<Ai.AiChat>({
      parent: d,
      isA: ai.classes.aiChat,
      propVals: {
        [core.properties.name]: q.slice(0, 50) || 'New Chat',
      },
    });

    await chatResource.save();

    n(constructOpenURL(chatResource.subject));
  };

  const resultsRef = useRef<HTMLDivElement | null>(null);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelected] = useState(0);

  const { searchQuery, tagSubjects } = useMemo(
    () => parseSearchTags(query, tagResources),
    [query, tagResources],
  );
  const filters: Record<string, string[]> =
    tagSubjects.length > 0
      ? { [dataBrowser.properties.tags]: tagSubjects }
      : {};
  const filterIsEmpty = Object.keys(filters).length === 0;
  const tags = tagSubjects;

  const { results, error } = useServerSearch(searchQuery, {
    debounce: 0,
    parents: scope || drive,
    include: true,
    filters,
    limit: 10,
    allowEmptyQuery: !filterIsEmpty,
  });

  const showAIChatRow = query && results.length === 0;
  const totalItemCount = results.length + (showAIChatRow ? 1 : 0);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);

    return () => clearTimeout(timer);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelected(0);
  };

  const handleKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(prev => (prev >= totalItemCount - 1 ? prev : prev + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(prev => (prev > 0 ? prev - 1 : 0));
        break;
      case 'Enter':
        e.preventDefault();

        if (results[selectedIndex]) {
          const openURL = constructOpenURL(results[selectedIndex]);
          navigate(openURL);
          closeOverlay();
        } else if (showAIChatRow && selectedIndex === results.length) {
          // AI Chat row selected
          await handleStartAIChat(query, store, drive, navigate);
          closeOverlay();
        }

        break;
      case 'Escape':
        e.preventDefault();
        closeOverlay();
        break;
    }
  };

  // Shift+Enter always starts an AI chat
  useHotkeys(
    'shift+enter',
    e => {
      e.preventDefault();

      void (async () => {
        await handleStartAIChat(query, store, drive, navigate);
        closeOverlay();
      })();
    },
    { enableOnFormTags: ['INPUT'] },
    [query, store, drive, navigate],
  );

  useEffect(() => {
    if (selectedIndex >= 0 && resultsRef.current) {
      const el = resultsRef.current.querySelector(
        `[data-index="${selectedIndex}"]`,
      ) as HTMLElement | null;
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [selectedIndex]);

  // Sync results + index to module state for the preview
  useEffect(() => {
    setSearchResults(results, selectedIndex);
  }, [results, selectedIndex]);

  return (
    <ErrorBoundary>
      <OverlayInputWrapper>
        <FaMagnifyingGlass size={16} />
        <OverlayInput
          ref={inputRef}
          value={query}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder='Search for resources...'
          autoComplete='off'
          autoCorrect='off'
          autoCapitalize='off'
          spellCheck={false}
        />
        <ShortcutHint onClick={closeOverlay}>esc</ShortcutHint>
      </OverlayInputWrapper>

      {error ? (
        <ErrorLook style={{ padding: '1rem' }}>{error.message}</ErrorLook>
      ) : (
        <>
          {tags.length > 0 && (
            <Row
              center
              gap='1ch'
              style={{
                padding: '0.5rem 1rem',
                borderBottom: '1px solid',
                fontSize: '0.875rem',
              }}
            >
              <TagHeading>With Tags:</TagHeading>
              <InlineFormattedResourceList subjects={tags} />
            </Row>
          )}

          <PanelContent>
            <ResultsList>
              <ResultsArea ref={resultsRef}>
                <Column gap='0'>
                  {results.map((subject, index) => (
                    <ResultCard
                      key={subject}
                      subject={subject}
                      index={index}
                      selected={index === selectedIndex}
                      onSelect={() => {
                        setSelected(index);
                        setTimeout(() => {
                          const openURL = constructOpenURL(subject);
                          navigate(openURL);
                          closeOverlay();
                        }, 80);
                      }}
                    />
                  ))}
                  {showAIChatRow && (
                    <AIChatRow
                      data-index={results.length}
                      $selected={selectedIndex === results.length}
                      onClick={async () => {
                        await handleStartAIChat(query, store, drive, navigate);
                        closeOverlay();
                      }}
                    >
                      <FaComments size={16} />
                      <span>Start AI Chat with "{query}"</span>
                    </AIChatRow>
                  )}
                </Column>
              </ResultsArea>
            </ResultsList>
          </PanelContent>

          <FooterRow>
            <FooterHints>
              <span>
                <kbd>↑</kbd> <kbd>↓</kbd> navigate
              </span>
              <span>
                <kbd>↵</kbd> open / chat
              </span>
              <span>
                <kbd>⇧↵</kbd> chat
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

interface ResultCardProps {
  subject: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

function CardPreview({ subject }: { subject: string }): JSX.Element {
  const [currentSubject] = useCurrentSubject();
  // Skip rendering the preview card if it's the same resource as the current page
  // to avoid duplicate view-transition-name conflicts.
  const skipCard = subject === currentSubject;

  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
      }}
    >
      {skipCard ? null : <ResourceCard subject={subject} />}
    </div>
  );
}

const ResultRowWrapper = styled.div<{ $selected?: boolean }>`
  display: block;
  width: 100%;
  cursor: pointer;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  background: ${p => (p.$selected ? p.theme.colors.bg1 : 'transparent')};
  transition: background 80ms;
`;

const ResultCard: React.FC<ResultCardProps> = ({
  subject,
  index,
  selected,
  onSelect,
}) => (
  <ResultRowWrapper data-index={index} onClick={onSelect} $selected={selected}>
    <ResourceRow subject={subject} clickable />
  </ResultRowWrapper>
);

// ─── Shortcuts Overlay ────────────────────────────────────────────────────────

const ShortcutRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  font-size: 0.875rem;

  &:last-child {
    border-bottom: none;
  }
`;

const ShortcutLabel = styled.span`
  color: ${p => p.theme.colors.text};
`;

const ShortcutKey = styled.kbd`
  background: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: 0.25rem;
  padding: 0.15rem 0.4rem;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  font-family: inherit;
`;

function displayShortcut(s: string): string {
  return s
    .replace('meta+', '⌘')
    .replace('option+', '⌥')
    .replace('shift+', '⇧')
    .replace('ctrl+', '⌃')
    .replace('backspace', '⌫');
}

function ShortcutsOverlay(): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);

    return () => clearTimeout(timer);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeOverlay();
    }
  };

  const shortcuts_list = [
    {
      key: navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K',
      label: 'Open search',
    },
    { key: 'Shift+/', label: 'Show keyboard shortcuts' },
    {
      key: navigator.platform.includes('Mac') ? '⌘E' : 'Ctrl+E',
      label: 'Edit resource',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘D' : 'Ctrl+D',
      label: 'Show data view',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘H' : 'Ctrl+H',
      label: 'Go home',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘N' : 'Ctrl+N',
      label: 'New resource',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘M' : 'Ctrl+M',
      label: 'Open menu',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘U' : 'Ctrl+U',
      label: 'User settings',
    },
    {
      key: navigator.platform.includes('Mac') ? '⌘T' : 'Ctrl+T',
      label: 'Theme settings',
    },
    { key: 'Shift+/', label: 'This page' },
  ];

  return (
    <>
      <OverlayInputWrapper>
        <span style={{ fontSize: '0.9rem', color: 'textLight' }}>
          Keyboard shortcuts
        </span>
        <OverlayInput
          ref={inputRef}
          onKeyDown={handleKeyDown}
          placeholder='Press esc to close...'
          readOnly
          style={{ cursor: 'default', fontSize: '0.875rem' }}
        />
        <ShortcutHint onClick={closeOverlay}>esc</ShortcutHint>
      </OverlayInputWrapper>
      <div>
        {shortcuts_list.map(({ key, label }) => (
          <ShortcutRow key={key}>
            <ShortcutLabel>{label}</ShortcutLabel>
            <ShortcutKey>{displayShortcut(key)}</ShortcutKey>
          </ShortcutRow>
        ))}
      </div>
    </>
  );
}

// ─── OverlayContainer ──────────────────────────────────────────────────────────

export function OverlayContainer(): JSX.Element | null {
  const [overlay, setOverlayState] = useState<OverlayType>(null);
  const [, setPreviewState] = useState({
    results: [] as string[],
    index: 0,
  });

  useEffect(() => {
    overlayListeners.add(setOverlayState);

    return () => {
      overlayListeners.delete(setOverlayState);
    };
  }, []);

  useEffect(() => {
    const handler = (isOpen: boolean, results: string[], index: number) => {
      setPreviewState({ results, index });
    };

    previewListeners.add(handler);

    return () => {
      previewListeners.delete(handler);
    };
  }, []);

  useHotkeys(
    shortcuts.search,
    e => {
      e.preventDefault();
      setOverlay('search');
    },
    {},
    [],
  );

  useHotkeys(
    '?',
    e => {
      e.preventDefault();
      setOverlay('shortcuts');
    },
    {},
    [],
  );

  useHotkeys(
    'escape',
    () => {
      closeOverlay();
    },
    {},
    [overlay],
  );

  if (overlay === null) {
    return null;
  }

  const previewSubject =
    overlay === 'search' && searchResults[searchSelectedIndex]
      ? searchResults[searchSelectedIndex]
      : null;

  return (
    <>
      <OverlayBackdrop onClick={closeOverlay} />
      <OverlayPanel onClick={e => e.stopPropagation()}>
        {overlay === 'search' && <SearchOverlay />}
        {overlay === 'shortcuts' && <ShortcutsOverlay />}
        {previewSubject && (
          <PreviewFloat>
            <CardPreview subject={previewSubject} />
          </PreviewFloat>
        )}
      </OverlayPanel>
    </>
  );
}
