import { langTagRegex, useValue, type LocalizedText } from '@tomic/react';
import { useDeclaredLanguages } from '../../hooks/useDeclaredLanguages';
import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { FaPlus, FaTrash } from 'react-icons/fa6';
import { InputProps } from './ResourceField';
import { InputStyled, InputWrapper } from './InputStyles';
import { ErrorChipInput } from './ErrorChip';
import {
  checkForInitialRequiredValue,
  useValidation,
} from './formValidation/useValidation';
import { Button } from '../Button';
import { Column, Row } from '../Row';

/**
 * Edits a LocalizedText value: one text input per language tag, plus an
 * affordance to add a new (BCP 47 validated) language.
 */
export default function InputLocalizedText({
  resource,
  property,
  commit,
  commitDebounceInterval,
  id,
  labelId: _labelId,
  ...props
}: InputProps): JSX.Element {
  const [value, setValue] = useValue(resource, property.subject, {
    commit,
    commitDebounce: commitDebounceInterval,
    validate: false,
  });

  const translations = (value as LocalizedText | undefined) ?? {};
  const declared = useDeclaredLanguages();

  // With a declared language set, every declared language gets a row —
  // absent ones render as visibly empty, so missing translations are seen,
  // not hidden. Undeclared-but-present tags (legacy data) still show.
  const rowTags = declared
    ? [
        ...declared,
        ...Object.keys(translations)
          .filter(tag => !declared.includes(tag))
          .sort(),
      ]
    : Object.keys(translations);

  const { error, setError, setTouched } = useValidation(
    checkForInitialRequiredValue(value, props.required),
  );

  const [newTag, setNewTag] = useState('');
  const [tagError, setTagError] = useState<string | undefined>(undefined);

  function write(next: LocalizedText): void {
    if (Object.keys(next).length === 0) {
      setValue(undefined);
      setError(props.required ? 'Required' : undefined);

      return;
    }

    setValue(next);
    setError(undefined);
  }

  function handleTextChange(tag: string, text: string): void {
    // A cleared declared row goes back to "missing" (key absent) rather than
    // an empty-string translation; its row persists via the declared set.
    if (text === '' && declared?.includes(tag)) {
      const { [tag]: _cleared, ...rest } = translations;
      write(rest);

      return;
    }

    write({ ...translations, [tag]: text });
  }

  function handleRemoveLanguage(tag: string): void {
    const { [tag]: _removed, ...rest } = translations;
    write(rest);
  }

  function handleAddLanguage(): void {
    const tag = newTag.trim();

    if (tag.match(langTagRegex) === null) {
      setTagError('Invalid language tag');

      return;
    }

    if (translations[tag] !== undefined) {
      setTagError('Language already added');

      return;
    }

    write({ ...translations, [tag]: '' });
    setNewTag('');
    setTagError(undefined);
  }

  return (
    <Wrapper>
      <Column gap='0.5rem'>
        {rowTags.map((tag, index) => (
          <Row gap='1ch' center key={tag}>
            <LangTag $missing={translations[tag] === undefined}>{tag}</LangTag>
            <InputWrapper $invalid={!!error}>
              <InputStyled
                id={index === 0 ? id : undefined}
                value={translations[tag] ?? ''}
                aria-label={`Translation for ${tag}`}
                disabled={props.disabled}
                autoFocus={index === 0 ? props.autoFocus : undefined}
                onChange={e => handleTextChange(tag, e.target.value)}
                onBlur={setTouched}
              />
            </InputWrapper>
            {!declared?.includes(tag) && (
              <Button
                icon
                subtle
                type='button'
                title={`Remove ${tag} translation`}
                disabled={props.disabled}
                onClick={() => handleRemoveLanguage(tag)}
              >
                <FaTrash />
              </Button>
            )}
          </Row>
        ))}
        {!props.disabled && declared === undefined && (
          <Row gap='1ch' center>
            <TagInputWrapper $invalid={!!tagError}>
              <InputStyled
                id={rowTags.length === 0 ? id : undefined}
                value={newTag}
                placeholder='e.g. en or de-DE'
                aria-label='New language tag'
                onChange={e => {
                  setNewTag(e.target.value);
                  setTagError(undefined);
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    handleAddLanguage();
                  }
                }}
                onBlur={setTouched}
              />
            </TagInputWrapper>
            <Button
              subtle
              type='button'
              title='Add a language'
              disabled={newTag.trim() === ''}
              onClick={handleAddLanguage}
            >
              <Row gap='.5rem' center>
                <FaPlus /> Add language
              </Row>
            </Button>
          </Row>
        )}
      </Column>
      {(tagError ?? error) && (
        <ErrorChipInput top='100%'>{tagError ?? error}</ErrorChipInput>
      )}
    </Wrapper>
  );
}

const Wrapper = styled.div`
  flex: 1;
  position: relative;
`;

const LangTag = styled.span<{ $missing?: boolean }>`
  min-width: 5ch;
  font-family: monospace;
  color: ${p =>
    p.$missing ? p.theme.colors.warning : p.theme.colors.textLight};
`;

const TagInputWrapper = styled(InputWrapper)`
  max-width: 16ch;
  flex: 0 1 auto;
`;
