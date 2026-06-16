import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import { IconButton } from './IconButton/IconButton';
import { FaChevronDown } from 'react-icons/fa6';
import { useCombobox } from 'downshift';
import { Column } from './Row';
import styled, { css } from 'styled-components';
import { QuickScore } from 'quick-score';

const supportsAnchorPositioning =
  'anchorName' in document.documentElement.style;

export type ComboBoxOption = {
  label: string;
  searchLabel: string;
  description?: string;
  value: string;
};

type ComboBoxProps = {
  options: ComboBoxOption[];
  selectedItem: string | undefined;
  onSelect: (value: string | undefined) => void;
  subtle?: boolean;
};

export const ComboBox: React.FC<ComboBoxProps> = ({
  options,
  selectedItem,
  onSelect,
  subtle = false,
}) => {
  // Use Combobox does not work with the compiler.
  'use no memo';
  const id = useId();
  const anchorName = `--combo-box-${id.trim().replaceAll(':', '-')}`;
  const menuRef = useRef<HTMLUListElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const [menuAboveInput, setMenuAboveInput] = useState(false);
  const [isFocused, setIsFocused] = useState(false);

  const [items, setItems] = useState(options);

  const quickScore = useMemo(() => {
    return new QuickScore(options, ['label']);
  }, [options]);

  // Drive downshift as a fully controlled component: the selected item is always
  // derived from the `selectedItem` prop. This is the single source of truth.
  // (Previously a useEffect pushed the prop into downshift via selectItem(), which
  // fired onSelectedItemChange -> onSelect -> parent setState, feeding back into the
  // effect and causing an infinite update loop when switching models.)
  const selectedOption = useMemo(
    () => options.find(option => option.value === selectedItem) ?? null,
    [options, selectedItem],
  );

  const {
    isOpen,
    getInputProps,
    getToggleButtonProps,
    getMenuProps,
    getItemProps,
    highlightedIndex,
    setHighlightedIndex,
    selectedItem: downshiftSelectedItem,
    setInputValue,
    openMenu,
  } = useCombobox({
    items,
    selectedItem: selectedOption,
    onInputValueChange: ({ inputValue }) => {
      setHighlightedIndex(0);

      if (inputValue === '') {
        setItems(options);
        return;
      }

      setItems(quickScore.search(inputValue).map(r => r.item));
    },
    itemToString: item => item?.label ?? '',
    onSelectedItemChange: ({ selectedItem: item }) => {
      if (item?.value !== selectedItem) {
        onSelect(item?.value);
      }
    },
  });

  useEffect(() => {
    setItems(options);
  }, [options]);

  const { ref: downShiftMenuRef, ...menuRest } = getMenuProps();

  const setMenuRef = useCallback((node: HTMLUListElement) => {
    // @ts-expect-error - downshift types are not correct, it's a callback ref, not a ref object
    downShiftMenuRef(node);
    menuRef.current = node;
  }, []);

  const checkMenuPosition = useCallback(() => {
    if (!inputWrapperRef.current) return;
    const inputWrapperPosition =
      inputWrapperRef.current.getBoundingClientRect();
    const isNearBottom = inputWrapperPosition.bottom > window.innerHeight - 320;
    setMenuAboveInput(isNearBottom);
  }, []);

  useEffect(() => {
    if (!menuRef || !menuRef.current) return;

    if (isOpen) {
      menuRef.current.showPopover();
    } else {
      menuRef.current.hidePopover();
    }

    if (supportsAnchorPositioning)
      requestAnimationFrame(() => {
        checkMenuPosition();
      });
    else checkMenuPosition();
  }, [isOpen]);

  useEffect(() => {
    requestAnimationFrame(() => {
      checkMenuPosition();
    });
  }, [items]);

  useEffect(() => {
    if (!menuRef.current || !inputWrapperRef.current) return;

    if (!supportsAnchorPositioning) {
      import('@oddbird/css-anchor-positioning/fn').then(module => {
        module.default();
      });
    }
  }, [menuRef, inputWrapperRef]);

  const isActive = isFocused || isOpen;
  const showSubtle = subtle && !isActive;

  return (
    <Wrapper>
      <StyledInputWrapper
        anchorName={anchorName}
        ref={inputWrapperRef}
        className={menuAboveInput ? 'menu-above-input' : ''}
        $subtle={showSubtle}
      >
        <InputStyled
          {...getInputProps({
            onFocus: () => {
              setIsFocused(true);
              if (subtle) {
                setTimeout(() => {
                  setInputValue('');
                  openMenu();
                }, 0);
              }
            },
            onBlur: () => {
              setIsFocused(false);
              if (subtle) {
                setInputValue(downshiftSelectedItem?.label ?? '');
              }
            },
            onClick: e => {
              if (subtle) {
                // @ts-expect-error - Downshift custom event property
                e.preventDownshiftDefault = true;
              }
            },
            onMouseDown: e => {
              if (subtle) {
                // @ts-expect-error - Downshift custom event property
                e.preventDownshiftDefault = true;
              }
            },
          })}
        />
        {!showSubtle && (
          <IconButton {...getToggleButtonProps()}>
            <FaChevronDown />
          </IconButton>
        )}
      </StyledInputWrapper>
      <List
        $open={isOpen}
        anchorName={anchorName}
        {...menuRest}
        ref={setMenuRef}
        popover='manual'
        className={menuAboveInput ? 'menu-above-input' : ''}
      >
        {isOpen && (
          <>
            {items.map((item, index) => (
              <ListItem
                key={item.value}
                data-selected={index === highlightedIndex}
                {...getItemProps({ item, index })}
              >
                <Column gap='0.2rem'>
                  <span>{item.label}</span>
                  {item.description && (
                    <Description>{item.description}</Description>
                  )}
                </Column>
              </ListItem>
            ))}
            {items.length === 0 && (
              <ListItem>
                <Description>No results</Description>
              </ListItem>
            )}
          </>
        )}
      </List>
    </Wrapper>
  );
};

const Wrapper = styled.div`
  position: relative;

  &:has(li) {
    ${InputWrapper} {
      box-shadow: ${p => p.theme.boxShadowSoft};
      border-radius: ${p => p.theme.radius} ${p => p.theme.radius} 0 0;
      border-bottom: none;

      &.menu-above-input {
        border-radius: 0 0 ${p => p.theme.radius} ${p => p.theme.radius};
        border-bottom: solid 1px ${p => p.theme.colors.main};
        border-top: none;
      }
    }
  }
`;

const ListItem = styled.li`
  list-style: none;
  margin: 0;
  padding: ${p => p.theme.size(1)} ${p => p.theme.size(2)};
  font-size: 0.9rem;
  &[data-selected='true'] {
    background-color: ${p => p.theme.colors.mainSelectedBg};
    color: ${p => p.theme.colors.mainSelectedFg};
  }
`;

const Description = styled.span`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const List = styled.ul<{ $open: boolean; anchorName: string }>`
  max-height: ${p => p.theme.size(15)};
  overflow: auto;
  margin: 0;
  box-shadow: ${p => p.theme.boxShadowSoft};
  border-radius: 0 0 ${p => p.theme.radius} ${p => p.theme.radius};

  position-anchor: ${p => p.anchorName};
  top: anchor(bottom);
  left: anchor(left);
  bottom: unset;
  min-width: max(100%, 25rem);
  max-width: 95vw;
  background-color: ${p => p.theme.colors.bg};
  scrollbar-color: ${p => p.theme.colors.bg2} transparent;
  border: solid 1px ${p => p.theme.colors.main};
  border-top: none;
  position-try: flip-block;

  &.menu-above-input {
    top: unset;
    bottom: anchor(top);
    border-radius: ${p => p.theme.radius} ${p => p.theme.radius} 0 0;
    border-bottom: none;
    border-top: solid 1px ${p => p.theme.colors.main};
    box-shadow: none;
  }
`;

const StyledInputWrapper = styled(InputWrapper)<{ anchorName: string; $subtle?: boolean }>`
  anchor-name: ${p => p.anchorName};

  ${p =>
    p.$subtle &&
    css`
      border-color: transparent;
      background-color: transparent;

      input {
        background-color: transparent;
        border-color: transparent;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      &:hover:has(input:not(:disabled)),
      &:hover {
        background-color: ${p.theme.colors.bg1};
        border-color: transparent;
      }
    `}
`;
