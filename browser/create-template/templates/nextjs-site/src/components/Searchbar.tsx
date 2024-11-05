'use client';

import HStack from './Layout/HStack';
import styles from './Searchbar.module.css';
import FaMagnifyingGlass from './Icons/magnifying-glass-solid.svg';
import Image from 'next/image';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useThrottle } from '@/utils';

const Searchbar = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [val, setVal] = useState(searchParams.get('search') ?? '');
  const throttledValue = useThrottle(val, 200);

  useEffect(() => {
    if (throttledValue === '') {
      router.push(pathname);
    } else {
      router.push(`${pathname}?search=${throttledValue}`);
    }
  }, [throttledValue]);

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
        <input
          className={styles.input}
          type='search'
          value={val}
          onChange={e => {
            setVal(e.target.value);
          }}
          aria-label='Search'
          placeholder='Search blogposts...'
        />
      </HStack>
    </div>
  );
};

export default Searchbar;
