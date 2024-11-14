'use client';

import HStack from './Layout/HStack';
import styles from './Searchbar.module.css';
import FaMagnifyingGlass from './Icons/magnifying-glass-solid.svg';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useThrottle } from '@/hooks';

const Searchbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const throttledSearch = useThrottle(search, 200);

  useEffect(() => {
    if (throttledSearch === '') {
      router.push(pathname);
    } else {
      router.push(`${pathname}?search=${throttledSearch}`);
    }
  }, [throttledSearch, router, pathname]);

  return (
    <div className={styles.searchBar}>
      <HStack align='center' gap='1ch'>
        <Image
          priority
          width={16}
          height={16}
          src={FaMagnifyingGlass}
          alt='search'
        />

        {styles.hallo}
        <input
          className={styles.input}
          type='search'
          value={search}
          onChange={e => {
            setSearch(e.target.value);
          }}
          aria-label='Search blogposts...'
          placeholder='Search blogposts...'
        />
      </HStack>
    </div>
  );
};

export default Searchbar;
