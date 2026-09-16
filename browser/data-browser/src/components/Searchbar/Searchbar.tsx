import { Client, useResource, useTitle } from '@tomic/react';
import { useEffect, useRef, type JSX } from 'react';
import { styled } from 'styled-components';
import { constructOpenURL } from '../../helpers/navigation';
import { useQueryScopeHandler } from '../../hooks/useQueryScope';
import { IconButton, IconButtonVariant } from '../IconButton/IconButton';
import { FaMagnifyingGlass, FaXmark } from 'react-icons/fa6';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { SearchbarFakeInput, SearchbarInput } from './SearchbarInput';
import { useSearchOverlay } from './SearchOverlayContext';
import { withAlpha } from '../../styles/withAlpha';

export function Searchbar(): JSX.Element {
  const [currentSubject] = useCurrentSubject();
  const { scope, clearScope } = useQueryScopeHandler();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const { openSearch } = useSearchOverlay();

  const handleQueryChange = (_q: string, _tags: string[]) => {
    // No-op: query changes go through the command palette
  };

  const handleUrlChange = (url: string) => {
    try {
      Client.tryValidSubject(url);
      window.location.href = constructOpenURL(url);
    } catch {
      // Not a valid subject, do nothing
    }
  };

  useEffect(() => {
    if (scope !== undefined) {
      if (inputRef.current) {
        inputRef.current.innerText = '';
      }

      inputRef.current?.focus();

      return;
    }
  }, [scope]);

  const mutateText = (str: string) => {
    if (inputRef.current) {
      inputRef.current.innerText = str;
    }
  };

  return (
    <Wrapper>
      <IconButton
        color='textLight'
        title='Search (Cmd+K)'
        type='button'
        onClick={() => openSearch()}
      >
        <FaMagnifyingGlass />
      </IconButton>
      {scope && <ParentTag subject={scope} onClick={clearScope} />}
      <SearchbarInput
        onQueryChange={handleQueryChange}
        onURLChange={handleUrlChange}
        inputRef={inputRef}
        customValue={currentSubject}
        mutateText={mutateText}
      />
    </Wrapper>
  );
}

interface ParentTagProps {
  subject: string;
  onClick: () => void;
}

function ParentTag({ subject, onClick }: ParentTagProps): JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);

  return (
    <Tag>
      <span>in:{title} </span>
      <IconButton
        onClick={onClick}
        title='Clear scope'
        variant={IconButtonVariant.Simple}
        color='textLight'
        size='0.7rem'
        type='button'
      >
        <FaXmark />
      </IconButton>
    </Tag>
  );
}

const Wrapper = styled.div`
  flex: 1;
  height: 100%;
  gap: 1ch;
  display: flex;
  align-items: center;
  padding-inline: var(--space-2);
  overflow: hidden;
  border-radius: 999px;
  display: flex;

  :hover {
    ${withAlpha('var(--color-accent)', 0.4)};
    ${SearchbarFakeInput} {
      color: var(--color-text);
    }
  }
`;

const Tag = styled.span`
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  padding: 0.2rem 0.5rem;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.3rem;
  span {
    max-width: 15ch;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
`;
