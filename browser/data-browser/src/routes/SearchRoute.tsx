import { useRef, useState } from 'react';
import { ContainerNarrow } from '../components/Containers';
import { useHotkeys } from 'react-hotkeys-hook';
import { useNavigate } from 'react-router-dom';
import { constructOpenURL, useSearchQuery } from '../helpers/navigation';
import ResourceCard from '../views/Card/ResourceCard';
import { useServerSearch } from '@tomic/react';
import { ErrorLook } from '../components/ErrorLook';
import { styled } from 'styled-components';
import { FaSearch } from 'react-icons/fa';
import { useQueryScopeHandler } from '../hooks/useQueryScope';
import { useSettings } from '../helpers/AppSettings';
import { Column } from '../components/Row';
import { Main } from '../components/Main';

/** Full text search route */
export function Search(): JSX.Element {
  const [query] = useSearchQuery();
  const { drive } = useSettings();
  const { scope } = useQueryScopeHandler();
  const [enableFilter, setEnableFilter] = useState(false);

  useHotkeys(
    'f12',
    e => {
      e.preventDefault();
      setEnableFilter(!enableFilter);
    },
    [enableFilter],
  );

  const [selectedIndex, setSelected] = useState(0);
  const { results, loading, error } = useServerSearch(query, {
    debounce: 0,
    parents: scope || drive,
    include: true,
  });
  const navigate = useNavigate();
  const resultsDiv = useRef<HTMLDivElement | null>(null);

  function selectResult(index: number) {
    setSelected(index);
    const currentElm = resultsDiv?.current?.children[index];
    currentElm?.scrollIntoView({ block: 'nearest' });
  }

  useHotkeys(
    'enter',
    e => {
      e.preventDefault();
      const subject =
        resultsDiv?.current?.children[selectedIndex]?.getAttribute('about');

      if (subject) {
        //@ts-ignore blur does exist though
        document?.activeElement?.blur();
        const openURL = constructOpenURL(subject);
        navigate(openURL);
      }
    },
    { enableOnTags: ['INPUT'] },
  );
  useHotkeys(
    'up',
    e => {
      e.preventDefault();
      const newSelected = selectedIndex > 0 ? selectedIndex - 1 : 0;
      selectResult(newSelected);
    },
    { enableOnTags: ['INPUT'] },
  );
  useHotkeys(
    'down',
    e => {
      e.preventDefault();
      const newSelected =
        selectedIndex === results.length - 1
          ? results.length - 1
          : selectedIndex + 1;
      selectResult(newSelected);
    },
    { enableOnTags: ['INPUT'] },
  );

  let message: string | undefined = 'No hits';

  if (query?.length === 0) {
    message = 'Enter a search query';
  }

  if (loading) {
    message = 'Loading results...';
  }

  if (results.length > 0) {
    message = undefined;
  }

  return (
    <Main>
      <ContainerNarrow>
        {error ? (
          <ErrorLook>{error.message}</ErrorLook>
        ) : (
          <>
            <Heading>
              <FaSearch />
              <span>
                {message ? (
                  message
                ) : (
                  <>
                    {results.length} {results.length > 1 ? 'Results' : 'Result'}{' '}
                    for <QueryText>{query}</QueryText>
                  </>
                )}
              </span>
            </Heading>
            <Column ref={resultsDiv} gap='1rem'>
              {results.map((subject, index) => (
                <ResourceCard
                  initialInView={index < 5}
                  subject={subject}
                  key={subject}
                  highlight={index === selectedIndex}
                />
              ))}
            </Column>
          </>
        )}
      </ContainerNarrow>
    </Main>
  );
}

const Heading = styled.h1`
  color: ${p => p.theme.colors.text};
  display: flex;
  align-items: center;
  gap: 0.7ch;
  white-space: nowrap;
  overflow: hidden;
  line-height: 1.5;
  margin-bottom: ${p => p.theme.size(8)};

  & > span {
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

const QueryText = styled.span`
  color: ${p => p.theme.colors.textLight};
`;
