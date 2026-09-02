import { styled } from 'styled-components';
import type { JSX } from 'react';
import { useSettings } from '../helpers/AppSettings';
import { useDeclaredLanguages } from '../hooks/useDeclaredLanguages';

/**
 * Global switcher for the *content* language (LocalizedText values and
 * translated resources) — not the UI chrome language. Only rendered when the
 * current drive declares a `languages` set; without a declared set there is
 * nothing meaningful to switch between.
 */
export function ContentLanguageSelect(): JSX.Element | null {
  const { contentLanguage, setContentLanguage } = useSettings();
  const declared = useDeclaredLanguages();

  if (!declared) {
    return null;
  }

  const options = declared.includes(contentLanguage)
    ? declared
    : [contentLanguage, ...declared];

  return (
    <LanguageSelect
      value={contentLanguage}
      aria-label='Content language'
      title='Content language'
      onChange={e => setContentLanguage(e.target.value)}
    >
      {options.map(tag => (
        <option key={tag} value={tag}>
          {tag}
        </option>
      ))}
    </LanguageSelect>
  );
}

const LanguageSelect = styled.select`
  border: none;
  background: none;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  cursor: pointer;
  align-self: center;

  &:hover,
  &:focus-visible {
    color: ${p => p.theme.colors.text};
  }
`;
