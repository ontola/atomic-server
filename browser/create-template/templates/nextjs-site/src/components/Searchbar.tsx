'use client';

import HStack from './Layout/HStack';
import styles from './Searchbar.module.css';
import FaMagnifyingGlass from './Icons/magnifying-glass-solid.svg';
import Image from 'next/image';

const Searchbar = ({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) => {
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
          value={value}
          onChange={e => {
            onChange(e.target.value);
          }}
          aria-label='Search blogposts...'
          placeholder='Search blogposts...'
        />
      </HStack>
    </div>
  );
};

export default Searchbar;
