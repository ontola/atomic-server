import { Client, dataBrowser, useResource, useTitle } from '@tomic/react';
import { transparentize } from 'polished';
import { useEffect, useRef, type JSX } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FaTimes } from 'react-icons/fa';
import { styled } from 'styled-components';
import { constructOpenURL } from '../../helpers/navigation';
import { useQueryScopeHandler } from '../../hooks/useQueryScope';
import { shortcuts } from '../HotKeyWrapper';
import { IconButton, IconButtonVariant } from '../IconButton/IconButton';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import { useNavigate } from '@tanstack/react-router';
import { paths } from '../../routes/paths';
import { useCurrentSubject } from '../../helpers/useCurrentSubject';
import { SearchbarFakeInput, SearchbarInput } from './SearchbarInput';
import {
  base64StringToFilter,
  filterToBase64String,
} from '../../routes/Search/searchUtils';

function addTagsToFilter(
  base64Filter: string | undefined,
  tags: string[],
): string {
  const filter = base64Filter ? base64StringToFilter(base64Filter) : {};

  filter[dataBrowser.properties.tags] = tags;

  return filterToBase64String(filter);
}

const getText = (inputRef: React.RefObject<HTMLInputElement | null>) => {
  if (!inputRef.current) return '';

  return inputRef.current.textContent ?? '';
};

export function Searchbar(): JSX.Element {
  const [currentSubject] = useCurrentSubject();
  const { scope, clearScope } = useQueryScopeHandler();
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();

  const setQuery = useDebouncedCallback((q: string, tags: string[]) => {
    try {
      Client.tryValidSubject(q);
      // Replace instead of push to make the back-button behavior better.
      navigate({ to: constructOpenURL(q), replace: true });
    } catch (_err) {
      navigate({
        to: paths.search,
        search: prev => ({
          query: q,
          ...(scope ? { queryscope: scope } : {}),
          ...(tags.length > 0
            ? { filters: addTagsToFilter(prev.filters, tags) }
            : {}),
        }),
        replace: true,
      });
    }
  }, 20);

  const mutateText = (str: string) => {
    if (inputRef.current) {
      inputRef.current.innerText = str;
    }
  };

  const handleQueryChange = (q: string, tags: string[]) => {
    setQuery(q, tags);
  };

  const handleUrlChange = (url: string) => {
    Client.tryValidSubject(url);
    // Replace instead of push to make the back-button behavior better.
    navigate({ to: constructOpenURL(url), replace: true });
  };

  const onSearchButtonClick = () => {
    navigate({ to: paths.search });
    inputRef.current?.focus();
  };

  useHotkeys(shortcuts.search, e => {
    e.preventDefault();

    inputRef.current?.focus();
  });

  useHotkeys(
    'backspace',
    _ => {
      if (getText(inputRef) === '') {
        if (scope) {
          clearScope();
        }
      }
    },
    { enableOnTags: ['INPUT'], enableOnContentEditable: true },
  );

  useEffect(() => {
    if (scope !== undefined) {
      mutateText('');
      inputRef.current?.focus();

      return;
    }
  }, [scope]);

  return (
    <Wrapper>
      <IconButton
        color='textLight'
        title='Start searching'
        type='button'
        onClick={onSearchButtonClick}
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

function useDebouncedCallback(
  callback: (query: string, tags: string[]) => void,
  timeout: number,
): (query: string, tags: string[]) => void {
  const timeoutId = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cb = (query: string, tags: string[]) => {
    if (timeoutId.current) {
      clearTimeout(timeoutId.current);
    }

    timeoutId.current = setTimeout(async () => {
      callback(query, tags);
    }, timeout);
  };

  return cb;
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
        <FaTimes />
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
  padding-inline: ${p => p.theme.size(2)};
  overflow: hidden;
  border-radius: 999px;
  display: flex;

  :hover {
    ${props => transparentize(0.6, props.theme.colors.main)};
    ${SearchbarFakeInput} {
      color: ${p => p.theme.colors.text};
    }
  }
`;

const Tag = styled.span`
  background-color: ${props => props.theme.colors.bg1};
  border-radius: ${props => props.theme.radius};
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
