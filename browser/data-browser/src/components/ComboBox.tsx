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
import styled from 'styled-components';
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
};

export const ComboBox: React.FC<ComboBoxProps> = ({
  options,
  selectedItem,
  onSelect,
}) => {
  // Use Combobox does not work with the compiler.
  // eslint-disable-next-line react-compiler/react-compiler
  'use no memo';
  const id = useId();
  const anchorName = `--combo-box-${id.trim().replaceAll(':', '-')}`;
  const menuRef = useRef<HTMLUListElement>(null);
  const inputWrapperRef = useRef<HTMLDivElement>(null);
  const [menuAboveInput, setMenuAboveInput] = useState(false);

  const [items, setItems] = useState(options);

  const quickScore = useMemo(() => {
    return new QuickScore(options, ['label']);
  }, [options]);

  const {
    isOpen,
    getInputProps,
    getToggleButtonProps,
    getMenuProps,
    getItemProps,
    highlightedIndex,
    setHighlightedIndex,
  } = useCombobox({
    items,
    onInputValueChange: ({ inputValue }) => {
      setHighlightedIndex(0);

      if (inputValue === '') {
        setItems(options);
      }

      setItems(quickScore.search(inputValue).map(r => r.item));
    },
    itemToString: item => item?.label ?? '',
    initialSelectedItem: options.find(option => option.value === selectedItem),
    onSelectedItemChange: ({ selectedItem: item }) => {
      onSelect(item?.value);
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
    if (!inputWrapperRef.current || !menuRef.current) return;
    // NOTE: For some reason firefox does not measure the position correctly, could be due to the polyfill, not fixing this now.
    const inputWrapperPosition =
      inputWrapperRef.current.getBoundingClientRect();
    const menuPosition = menuRef.current.getBoundingClientRect();
    setMenuAboveInput(menuPosition.top < inputWrapperPosition.top);
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

  return (
    <Wrapper>
      <StyledInputWrapper
        anchorName={anchorName}
        ref={inputWrapperRef}
        className={menuAboveInput ? 'menu-above-input' : ''}
      >
        <InputStyled {...getInputProps()} />
        <IconButton {...getToggleButtonProps()}>
          <FaChevronDown />
        </IconButton>
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
  right: anchor(right);
  bottom: unset;
  width: stretch;
  width: -webkit-fill-available;
  width: -moz-available;
  background-color: ${p => p.theme.colors.bg};
  scrollbar-color: ${p => p.theme.colors.bg2} transparent;
  border: solid 1px ${p => p.theme.colors.main};
  border-top: none;
  position-try: flip-block;

  &.menu-above-input {
    border-radius: ${p => p.theme.radius} ${p => p.theme.radius} 0 0;
    border-bottom: none;
    border-top: solid 1px ${p => p.theme.colors.main};
    box-shadow: none;
  }
`;

const StyledInputWrapper = styled(InputWrapper)<{ anchorName: string }>`
  anchor-name: ${p => p.anchorName};
`;
