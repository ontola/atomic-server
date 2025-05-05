import { useEffect, useRef, useState, type JSX } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { styled } from 'styled-components';
import { shortcuts } from './HotKeyWrapper';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../helpers/navigation';
import { useServerSearch } from '@tomic/react';
import { useSettings } from '../helpers/AppSettings';
import { useQueryScopeHandler } from '../hooks/useQueryScope';
import { Column, Row } from './Row';
import { ErrorBoundary } from '../views/ErrorPage';
import { ErrorLook } from './ErrorLook';

import { InlineFormattedResourceList } from './InlineFormattedResourceList';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import ResourceLine from '../views/ResourceLine';
import ResourceCard from '../views/Card/ResourceCard';

// ─── Module-level overlay state ────────────────────────────────────────────────

type OverlayType = 'search' | 'shortcuts' | null;

let activeOverlay: OverlayType = null;
const overlayListeners = new Set<(overlay: OverlayType) => void>();

function getOverlay(): OverlayType {
  return activeOverlay;
}

function setOverlay(overlay: OverlayType): void {
  activeOverlay = overlay;
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

const OverlayPanel = styled.div`
  position: fixed;
  top: 15vh;
  left: 40%;
  transform: translateX(-50%);
  z-index: ${p => p.theme.zIndex.searchOverlay};
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
      opacity: 0;
      transform: translateX(-50%) translateY(-12px);
    }
    to {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
  }
`;

const PanelContent = styled.div`
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;

  @media (min-width: 40rem) {
    flex-direction: row;
  }
`;

const ResultsList = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  min-width: 0;
`;

const PreviewFloat = styled.div`
  position: absolute;
  top: 0;
  right: -1rem;
  transform: translateX(100%);
  z-index: ${p => p.theme.zIndex.searchOverlay + 1};
  width: 18rem;
  height: 30rem;
  overflow-y: auto;
`;

const OverlayInputWrapper = styled.div`
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

const OverlayInput = styled.input`
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
  cursor: pointer;
  flex-shrink: 0;
`;

const ResultsArea = styled.div`
  flex: 1;
  overflow-y: auto;
  &:empty {
    display: none;
  }
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

const HeadingRow = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.875rem;
`;

// ─── Search Overlay ────────────────────────────────────────────────────────────

function SearchOverlay(): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { drive } = useSettings();
  const { scope } = useQueryScopeHandler();
  const navigate = useNavigateWithTransition();
  const resultsRef = useRef<HTMLDivElement | null>(null);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelected] = useState(0);

  const filters = {};
  const filterIsEmpty = true;
  const tags: string[] = [];

  const { results, loading, error } = useServerSearch(query, {
    debounce: 0,
    parents: scope || drive,
    include: true,
    filters,
    allowEmptyQuery: !filterIsEmpty,
  });

  useEffect(() => {
    const timer = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
    setSelected(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelected(prev => {
          const next = prev === results.length - 1 ? prev : prev + 1;
          setSearchResults(results, next);
          return next;
        });
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelected(prev => {
          const next = prev > 0 ? prev - 1 : 0;
          setSearchResults(results, next);
          return next;
        });
        break;
      case 'Enter':
        e.preventDefault();
        if (results[selectedIndex]) {
          const openURL = constructOpenURL(results[selectedIndex]);
          navigate(openURL);
          closeOverlay();
        }
        break;
      case 'Escape':
        e.preventDefault();
        closeOverlay();
        break;
    }
  };

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

  const heading = !query
    ? undefined
    : results.length === 0
      ? 'No hits'
      : undefined;

  const showHelper = !query && filterIsEmpty;

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
          {heading && (
            <HeadingRow>
              <FaMagnifyingGlass size={12} />
              {heading}
            </HeadingRow>
          )}

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

interface ResultCardProps {
  subject: string;
  index: number;
  selected: boolean;
  onSelect: () => void;
}

function CardPreview({ subject }: { subject: string }): JSX.Element {
  return (
    <div
      style={{
        position: 'sticky',
        top: 0,
      }}
    >
      <ResourceCard subject={subject} />
    </div>
  );
}

const ResultCardDiv = styled.div<{ $selected?: boolean }>`
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
  <ResultCardDiv data-index={index} onClick={onSelect} $selected={selected}>
    <ResourceLine subject={subject} clickable />
  </ResultCardDiv>
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
    .replace('cmd+', '⌘')
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
  const [previewState, setPreviewState] = useState({
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
        {overlay === 'search' && previewState.results[previewState.index] && (
          <PreviewFloat>
            <CardPreview subject={previewState.results[previewState.index]} />
          </PreviewFloat>
        )}
      </OverlayPanel>
    </>
  );
}
