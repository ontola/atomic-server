import {
  core,
  JSONValue,
  Store,
  useArray,
  useResource,
  useStore,
} from '@tomic/react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { FaPlus } from 'react-icons/fa';
import { styled } from 'styled-components';
import { IconButton } from '../../../components/IconButton/IconButton';
import { TagButton, Tag } from '../../../components/Tag';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';
import {
  InputStyled,
  InputWrapper,
} from '../../../components/forms/InputStyles';
import { Row } from '../../../components/Row';
import { stringToSlug } from '../../../helpers/stringToSlug';
import { loopingIndex } from '../../../helpers/loopingIndex';
import { fadeIn } from '../../../helpers/commonAnimations';
import {
  KeyboardInteraction,
  useCellOptions,
} from '../../../components/TableEditor';
import { useTableEditorContext } from '../../../components/TableEditor/TableEditorContext';
import { AbsoluteCell } from './CellComponents';
import { FaXmark } from 'react-icons/fa6';
import { CustomPopover, usePopover } from '@components/CustomPopover';

const TAG_SPACING = '0.5rem';

const emptyArray: string[] = [];

function buildListWithTitles(
  store: Store,
  subjects: string[],
  ignore: string[],
): { subject: string; title: string }[] {
  return subjects
    .filter(v => !ignore.includes(v))
    .map(subject => {
      const resource = store.getResourceLoading(subject);
      const title = resource?.get(core.properties.shortname) ?? subject;

      return { subject, title: title as string };
    });
}

function SelectCellEdit({
  value,
  property,
  onChange,
}: EditCellProps<JSONValue>): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const val = (value as string[]) ?? emptyArray;
  const store = useStore();
  const propertyResource = useResource(property);
  const [allowsOnly] = useArray(propertyResource, core.properties.allowsOnly);
  const [query, setQuery] = useState('');

  const filteredTags = buildListWithTitles(store, allowsOnly, val)
    .filter(v => v.title.includes(query))
    .map(ft => ft.subject);

  const { isOpen, closePopover, triggerProps, popoverProps } = usePopover({
    defaultOpen: true,
    autoFocusElement: inputRef,
  });
  const [selectedIndex, setSelectedIndex] = useState(0);

  const { activeCellRef } = useTableEditorContext();

  const disabledKeyboardInteractions = new Set<KeyboardInteraction>([
    KeyboardInteraction.EditNextRow,
  ]);

  if (isOpen) {
    disabledKeyboardInteractions.add(KeyboardInteraction.ExitEditMode);
  }

  const cellOptions = {
    disabledKeyboardInteractions,
    hideActiveIndicator: true,
  };

  useCellOptions(cellOptions);

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(stringToSlug(e.target.value));
    setSelectedIndex(0);
  };

  const handleAddTag = (subject: string) => {
    onChange(Array.from(new Set([...val, subject])));
  };

  const handleRemoveTag = (subject: string) => {
    onChange(val.filter(tagSubject => tagSubject !== subject));
  };

  const changeSelection = (mod: number) => {
    setSelectedIndex(prev => loopingIndex(prev + mod, filteredTags.length));
  };

  useEffect(() => {
    if (!isOpen) {
      activeCellRef.current?.focus();
    }
  }, [activeCellRef, isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        changeSelection(-1);
        break;
      case 'ArrowDown':
        e.preventDefault();
        changeSelection(1);
        break;
      case 'Enter':
        e.preventDefault();
        handleAddTag(filteredTags[selectedIndex]);
        break;
      case 'Escape':
        e.preventDefault();

        closePopover();
        break;
    }
  };

  return (
    <AbsoluteCell>
      <Row gap={TAG_SPACING} center wrapItems>
        {val.map(v => (
          <Tag subject={v} key={v}>
            <TagIconButton
              title='remove tag'
              onClick={() => handleRemoveTag(v)}
            >
              <FaXmark />
            </TagIconButton>
          </Tag>
        ))}
        <CustomPopover
          noLock
          Trigger={
            <IconButton title='Add tag' type='button' {...triggerProps}>
              <StyledIcon />
            </IconButton>
          }
          {...popoverProps}
        >
          <Content onKeyDown={handleKeyDown}>
            <SearchInputWrapper>
              <InputStyled
                placeholder='Filter tags...'
                onChange={handleSearch}
                ref={inputRef}
              />
            </SearchInputWrapper>
            <ResultWrapper>
              <Row wrapItems gap={TAG_SPACING}>
                {filteredTags.map((v, i) => (
                  <TagButton
                    key={v}
                    subject={v}
                    onClick={handleAddTag}
                    selected={i === selectedIndex}
                  />
                ))}
                {filteredTags.length === 0 && 'No results'}
              </Row>
            </ResultWrapper>
          </Content>
        </CustomPopover>
      </Row>
    </AbsoluteCell>
  );
}

function SelectCellDisplay({
  value,
}: DisplayCellProps<JSONValue>): JSX.Element {
  if (!value) {
    return <></>;
  }

  return (
    <Row gap={TAG_SPACING}>
      {(value as string[]).map(v => (
        <Tag subject={v} key={v} />
      ))}
    </Row>
  );
}

const StyledIcon = styled(FaPlus)`
  animation: ${fadeIn} 0.1s ease-in-out;
  color: ${p => p.theme.colors.textLight};
`;

const TagIconButton = styled(IconButton)`
  height: unset;
  width: unset;
  padding: unset;

  color: var(--tag-dark-color);
  background-blend-mode: lighten;

  &:not([disabled]):hover,
  &:not([disabled]):focus {
    transform: scale(1.2);
    background-color: unset;
  }
`;

const Content = styled.div`
  width: min(40ch, 90vh);
  border-radius: ${p => p.theme.radius};
`;

const ResultWrapper = styled.div`
  padding: ${p => p.theme.margin}rem;
  border: ${p =>
    p.theme.darkMode ? '1px solid ' + p.theme.colors.bg2 : 'none'};
  border-top: none;
  border-bottom-left-radius: ${p => p.theme.radius};
  border-bottom-right-radius: ${p => p.theme.radius};
`;

const SearchInputWrapper = styled(InputWrapper)`
  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;
`;

export const SelectCell: CellContainer<JSONValue> = {
  Edit: SelectCellEdit,
  Display: SelectCellDisplay,
};
