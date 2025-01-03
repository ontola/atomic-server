import { Client, useResource, useTitle } from '@tomic/react';
import { transparentize } from 'polished';
import React, { useEffect, useRef, useState, type JSX } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { FaTimes } from 'react-icons/fa';
import { styled } from 'styled-components';
import { constructOpenURL } from '../helpers/navigation';
import { useQueryScopeHandler } from '../hooks/useQueryScope';
import { shortcuts } from './HotKeyWrapper';
import { IconButton, IconButtonVariant } from './IconButton/IconButton';
import { FaMagnifyingGlass } from 'react-icons/fa6';
import { isURL } from '../helpers/isURL';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { paths } from '../routes/paths';
import { useCurrentSubject } from '../helpers/useCurrentSubject';

export interface SearchbarProps {
  onFocus?: React.FocusEventHandler<HTMLInputElement>;
  onBlur?: React.FocusEventHandler<HTMLInputElement>;
  subject?: string;
}

export function Searchbar({
  onFocus,
  onBlur,
  subject,
}: SearchbarProps): JSX.Element {
  const [currentSubject] = useCurrentSubject();
  const { query } = useSearch({ strict: false });
  const [input, setInput] = useState<string>(currentSubject ?? query ?? '');
  const { scope, clearScope } = useQueryScopeHandler();
  const searchBarRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const navigate = useNavigate();

  const setQuery = useDebouncedCallback((q: string) => {
    try {
      Client.tryValidSubject(q);
      // Replace instead of push to make the back-button behavior better.
      navigate({ to: constructOpenURL(q), replace: true });
    } catch (_err) {
      navigate({
        to: paths.search,
        search: {
          query: q,
          ...(scope ? { queryscope: scope } : {}),
        },
        replace: true,
      });
    }
  }, 20);

  const handleInput = (q: string) => {
    setInput(q);
    setQuery(q);
  };

  const handleSelect: React.MouseEventHandler<HTMLInputElement> = e => {
    if (isURL(input ?? '')) {
      // @ts-ignore
      e.target.select();
    }
  };

  const handleSubmit: React.FormEventHandler<HTMLFormElement> = event => {
    if (!subject) {
      return;
    }

    event.preventDefault();

    inputRef.current?.blur();
    //@ts-expect-error This should work
    document.activeElement?.blur();
    navigate({ to: constructOpenURL(subject), replace: true });
  };

  const onSearchButtonClick = () => {
    navigate({ to: paths.search });
    inputRef.current?.focus();
  };

  useHotkeys(shortcuts.search, e => {
    e.preventDefault();

    inputRef.current?.select();
    inputRef.current?.focus();
  });

  useHotkeys(
    'esc',
    e => {
      e.preventDefault();
      inputRef.current?.blur();
    },
    { enableOnTags: ['INPUT'] },
  );

  useHotkeys(
    'backspace',
    _ => {
      if (input === undefined || input.length === 0) {
        if (scope) {
          clearScope();
        }
      }
    },
    { enableOnTags: ['INPUT'] },
  );

  useEffect(() => {
    if (query !== undefined) {
      return;
    }

    if (scope !== undefined) {
      setInput('');

      return;
    }

    if (currentSubject) {
      setInput(currentSubject);

      return;
    }

    setInput('');
  }, [query, scope, currentSubject]);

  return (
    <Form onSubmit={handleSubmit} autoComplete='off' ref={searchBarRef}>
      <IconButton
        color='textLight'
        title='Start searching'
        type='button'
        onClick={onSearchButtonClick}
      >
        <FaMagnifyingGlass />
      </IconButton>
      {scope && <ParentTag subject={scope} onClick={clearScope} />}
      <Input
        autoComplete='false'
        ref={inputRef}
        type='search'
        data-test='address-bar'
        name='search'
        aria-label='Search'
        onClick={handleSelect}
        onFocus={onFocus}
        onBlur={onBlur}
        value={input || ''}
        onChange={e => handleInput(e.target.value)}
        placeholder='Enter an Atomic URL or search   (press "/" )'
      />
    </Form>
  );
}

function useDebouncedCallback(
  callback: (query: string) => void,
  timeout: number,
): (query: string) => void {
  const timeoutId = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cb = (query: string) => {
    if (timeoutId.current) {
      clearTimeout(timeoutId.current);
    }

    timeoutId.current = setTimeout(async () => {
      callback(query);
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
        variant={IconButtonVariant.Fill}
        color='textLight'
        size='0.8rem'
        type='button'
      >
        <FaTimes />
      </IconButton>
    </Tag>
  );
}

const Input = styled.input`
  border: none;
  font-size: 0.9rem;
  padding-block: 0.4rem;
  padding-inline-start: 0rem;
  color: ${props => props.theme.colors.text};
  width: 100%;
  flex: 1;
  min-width: 1rem;
  height: 100%;
  background-color: ${props => props.theme.colors.bg};
  // Outline is handled by the Navbar.
  outline: none;
  color: ${p => p.theme.colors.textLight};
`;

const Form = styled.form`
  flex: 1;
  height: 100%;
  gap: 0.5rem;
  display: flex;
  align-items: center;
  padding-inline: ${p => p.theme.size(3)};
  border-radius: 999px;

  :hover {
    ${props => transparentize(0.6, props.theme.colors.main)};
    ${Input} {
      color: ${p => p.theme.colors.text};
    }
  }
  :focus-within {
    ${Input} {
      color: ${p => p.theme.colors.text};
    }

    // Outline is handled by the Navbar.
    outline: none;
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
