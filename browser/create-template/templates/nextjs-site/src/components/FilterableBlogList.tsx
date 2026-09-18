'use client';

import {
  Children,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import Searchbar from './Searchbar';
import Container from './Layout/Container';
import HStack from './Layout/HStack';

/**
 * Client-side title filter over already-rendered cards. The full list stays in
 * the HTML (CDN-cacheable, no `?search=` on the server), and typing does not
 * hit AtomicServer.
 */
const FilterableBlogList = ({
  heading,
  titles,
  children,
}: {
  heading: ReactNode;
  titles: string[];
  children: ReactNode;
}) => {
  const [query, setQuery] = useState('');
  const childArray = Children.toArray(children);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      childArray.filter((_, index) => {
        if (!needle) {
          return true;
        }

        return (titles[index] ?? '').toLowerCase().includes(needle);
      }),
    [childArray, needle, titles],
  );

  return (
    <>
      <HStack wrap fullWidth align='center' justify='space-between'>
        {heading}
        <Searchbar value={query} onChange={setQuery} />
      </HStack>
      {visible.length > 0 ? (
        <ul>{visible}</ul>
      ) : (
        <Container>
          <p>No results found.</p>
        </Container>
      )}
    </>
  );
};

export default FilterableBlogList;
