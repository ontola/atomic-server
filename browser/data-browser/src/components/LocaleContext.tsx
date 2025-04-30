import { useLocalStorage } from '@hooks/useLocalStorage';
import React, { createContext, useContext, useEffect, useState } from 'react';
import { loadLocale } from 'wuchale/load-utils';
import { useOnValueChange } from '@helpers/useOnValueChange';

interface LocaleContextType {
  locale: string;
  setLocale: (locale: string) => void;
}

const LocaleContext = createContext<LocaleContextType>({
  locale: 'en',
  setLocale: () => {},
});

export const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'de'];

export const LocaleProvider = ({ children }: React.PropsWithChildren) => {
  const [locale, setLocale] = useLocalStorage(
    'atomic.locale',
    getBrowserLocale(),
  );
  const [localeLoaded, setLocaleLoaded] = useState(false);

  useOnValueChange(() => {
    setLocaleLoaded(false);
  }, [locale]);

  useEffect(() => {
    loadLocale(locale).then(() => setLocaleLoaded(true));
  }, [locale]);

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {/* Refresh the whole tree when changing locale */}
      <React.Fragment key={localeLoaded ? 'loaded' : 'loading'}>
        {children}
      </React.Fragment>
    </LocaleContext.Provider>
  );
};

export const useLocale = () => {
  return useContext(LocaleContext);
};

const getBrowserLocale = () => {
  const locales = navigator.languages.map(x => x.trim().split(/-|_/)[0]);

  return locales.find(x => SUPPORTED_LOCALES.includes(x)) ?? 'en';
};
