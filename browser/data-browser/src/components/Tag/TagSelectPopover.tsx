import { styled } from 'styled-components';
import { Popover } from '../Popover';
import { CreateTagRow } from './CreateTagRow';
import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '../forms/Checkbox';
import { InputWrapper, InputStyled } from '../forms/InputStyles';
import { Column } from '../Row';
import { Tag } from './Tag';
import { useStore, type Resource } from '@tomic/react';
import { ScrollArea } from '../ScrollArea';
import { useSelectedIndex } from '../../hooks/useSelectedIndex';

interface TagSelectPopoverProps {
  tags: string[];
  selectedTags: string[];
  setSelectedTags: (tags: string[]) => void;
  onNewTag?: (tag: string) => void;
  newTagParent?: string;
  Trigger: React.ReactNode;
}

export const TagSelectPopover: React.FC<TagSelectPopoverProps> = ({
  tags,
  selectedTags,
  setSelectedTags,
  onNewTag,
  Trigger,
  newTagParent,
}) => {
  const store = useStore();

  const [popoverVisible, setPopoverVisible] = useState(false);
  const [filterValue, setFilterValue] = useState('');

  const filteredTags = tags
    .map(subject => {
      const tag = store.getResourceLoading(subject);

      return { subject, title: tag.title };
    })
    .filter(tag => tag.title.includes(filterValue))
    .map(t => t.subject);

  const { selectedIndex, onKeyDown, onMouseOver, resetIndex, usingKeyboard } =
    useSelectedIndex(filteredTags, index => {
      if (index !== undefined) {
        const tag = filteredTags[index];
        modifyTags(!selectedTags.includes(tag), tag);
      }
    });

  const handleNewTag = async (tag: Resource) => {
    try {
      await tag.save();
      onNewTag?.(tag.subject);
      setSelectedTags([...selectedTags, tag.subject]);
    } catch (error) {
      console.error(error);
    }
  };

  const reset = () => {
    resetIndex();
    setFilterValue('');
  };

  const modifyTags = (add: boolean, tag: string) => {
    if (add) {
      setSelectedTags([...selectedTags, tag]);
    } else if (selectedTags.includes(tag)) {
      setSelectedTags(selectedTags.filter(t => t !== tag));
    }
  };

  return (
    <StyledPopover
      open={popoverVisible}
      onOpenChange={open => {
        setPopoverVisible(open);
        reset();
      }}
      Trigger={Trigger}
      noArrow
    >
      <TagPopoverContentWrapper>
        <Column gap={'calc(1rem - 10px)'}>
          <InputWrapper>
            <InputStyled
              disabled={tags.length === 0}
              type='search'
              placeholder='filter tags'
              value={filterValue}
              onChange={e => {
                setFilterValue(e.target.value);
                // Reset selected index when the filter changes
                resetIndex();
              }}
              onKeyDown={onKeyDown}
            />
          </InputWrapper>
          <StyledScrollArea>
            <TagList>
              {tags.length === 0 && (
                <EmptyMessage>There are no tags yet.</EmptyMessage>
              )}
              {filteredTags.map((tag, index) => {
                const isSelected = selectedIndex === index;

                return (
                  <AutoscrollListItem
                    selected={isSelected}
                    blockAutoscroll={!usingKeyboard}
                    key={tag}
                  >
                    {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
                    <label
                      data-selected={isSelected}
                      tabIndex={-1}
                      // We already handle the keyboard events in the input
                      // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
                      onMouseOver={() => {
                        onMouseOver(index);
                      }}
                    >
                      <Checkbox
                        tabIndex={-1}
                        selected={isSelected}
                        checked={selectedTags.includes(tag)}
                        onChange={checked => {
                          modifyTags(checked, tag);
                        }}
                      />
                      <Tag subject={tag} />
                    </label>
                  </AutoscrollListItem>
                );
              })}
            </TagList>
          </StyledScrollArea>
          {onNewTag && !!newTagParent && (
            <CreateTagRow parent={newTagParent} onNewTag={handleNewTag} />
          )}
        </Column>
      </TagPopoverContentWrapper>
    </StyledPopover>
  );
};

const AutoscrollListItem: React.FC<
  React.PropsWithChildren<{ selected: boolean; blockAutoscroll: boolean }>
> = ({ selected, children, blockAutoscroll }) => {
  const ref = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (selected && !blockAutoscroll) {
      ref.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [selected, blockAutoscroll]);

  return <li ref={ref}>{children}</li>;
};

const StyledPopover = styled(Popover)`
  margin-top: ${p => p.theme.size(2)};
  background-color: ${p => p.theme.colors.bg};
`;
const TagPopoverContentWrapper = styled.div`
  padding: 1rem;

  width: fit-content;
`;

const TagList = styled.ul`
  margin: 2px;
  padding-block: 10px;
  display: flex;
  flex-direction: column;
  height: 100%;

  & li {
    list-style: none;
    margin: 0;
    user-select: none;

    & label {
      height: 100%;
      padding: ${p => p.theme.size(2)};
      border-radius: ${p => p.theme.radius};
      display: flex;
      align-items: center;
      gap: 1ch;
      cursor: pointer;

      &[data-selected='true'] {
        background-color: ${p => p.theme.colors.mainSelectedBg};
      }
    }
  }
`;

const StyledScrollArea = styled(ScrollArea)`
  height: min(20rem, 30dvh);
`;

const EmptyMessage = styled.div`
  height: 100%;
  display: grid;
  place-items: center;
  color: ${p => p.theme.colors.textLight};
`;
