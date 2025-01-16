import { useState, useRef, useEffect } from 'react';
import styled from 'styled-components';
import { useSettings } from '../../helpers/AppSettings';
import {
  dataBrowser,
  type Server,
  useArray,
  useResource,
  useResources,
} from '@tomic/react';
import { TagSuggestionOverlay } from './TagSuggestionOverlay';
import { useSelectedIndex } from '../../hooks/useSelectedIndex';
import { isURL } from '../../helpers/isURL';
import { polyfillPlaintextOnly } from './searchbarUtils';

interface SearchbarInputProps {
  inputRef: React.RefObject<HTMLDivElement | null>;
  customValue?: string;
  onQueryChange: (query: string, tags: string[]) => void;
  onURLChange: (url: string) => void;
  /** Only needed because of a bug in react compiler seeing the ref in props as immutable. */
  mutateText: (str: string) => void;
}

export type TagWithTitle = {
  subject: string;
  title: string;
};

function useTagList(): TagWithTitle[] {
  const { drive } = useSettings();
  const driveResource = useResource<Server.Drive>(drive);
  const [tags] = useArray(driveResource, dataBrowser.properties.tagList);
  const tagResourceMap = useResources(tags);

  return Array.from(tagResourceMap.entries()).map(([subject, resource]) => {
    return { subject, title: resource.title };
  });
}

// Gracefully fall back to a no-op implementation if the browser doesn't support the Highlight API.
const newHighlight = () => {
  if ('Highlight' in window) {
    return new window.Highlight();
  }

  // Cast to unknown first to avoid type checking, then to Highlight
  return {
    add: () => {},
    clear: () => {},
    priority: 0,
    type: 'highlight',
    forEach: () => {},
  } as unknown as Highlight;
};

function useTagHighlighting(
  inputRef: React.RefObject<HTMLDivElement | null>,
  validTags: TagWithTitle[],
) {
  const tagHighlight = useRef<Highlight>(newHighlight());

  useEffect(() => {
    if ('highlights' in CSS) {
      // @ts-expect-error Typescript doesn't know that set() exists
      CSS.highlights.set('tag-highlight', tagHighlight.current);

      return () => {
        // @ts-expect-error Typescript doesn't know that delete() exists
        CSS.highlights.delete('tag-highlight');
      };
    }
  }, []);

  return (str: string): TagWithTitle[] => {
    if (!inputRef.current) return [];

    // @ts-expect-error Typescript doesn't know that clear() exists
    tagHighlight.current.clear();

    const regex = /(?<=\btag:)[\w-]+/g;
    let m;

    const foundTags: TagWithTitle[] = [];

    while ((m = regex.exec(str)) !== null) {
      // This is necessary to avoid infinite loops with zero-width matches
      const text = m[0];
      const foundTag = validTags.find(t => t.title === text);
      if (!foundTag) continue;

      if (m.index === regex.lastIndex) {
        regex.lastIndex++;
      }

      const range = new Range();
      range.setStart(inputRef.current.firstChild!, m.index);
      range.setEnd(inputRef.current.firstChild!, regex.lastIndex);

      // @ts-expect-error Typescript doesn't know that add() exists
      tagHighlight.current.add(range);

      foundTags.push(foundTag);
    }

    return foundTags;
  };
}

function getFullTagFromPosition(text: string, start: number): string {
  // Remove everything before the start index, now the string starts with 'tag:',
  // Split the string by spaces so we have the full tag title as the first element.
  // Remove the 'tag:' prefix.
  return text.slice(start).split(' ')[0].slice(4);
}

function getTagAtCaretPosition(input: HTMLDivElement):
  | {
      rect: DOMRect;
      tag: string;
    }
  | undefined {
  const text = input.textContent;

  const selection = input.ownerDocument.defaultView?.getSelection();

  if (!text || !selection) return;

  if (selection.type !== 'Caret') return;

  const slicedText = text.slice(0, selection.anchorOffset);
  const match = slicedText.match(/tag:[\w-]*$/);

  if (!match) return;

  const range = new Range();
  range.setStart(input.firstChild!, match.index!);
  range.setEnd(input.firstChild!, match.index! + 'tag:'.length);
  const rect = range.getBoundingClientRect();

  return { rect, tag: getFullTagFromPosition(text, match.index!) };
}

function extractQueryFromText(text: string): string {
  const tagTokenRegex = /\btag:[\w-]*/g;

  return text.replace(tagTokenRegex, '').trim();
}

function replacePartialTagWithFullTag(
  input: HTMLDivElement,
  selectedTag: string,
) {
  const selection = window.getSelection();

  if (!selection || selection.rangeCount === 0) return;

  const textContent = input.textContent || '';
  const caretOffset = selection.anchorOffset;
  const match = textContent.slice(0, caretOffset).match(/tag:[\w-]*$/);

  if (!match) return;

  const startIndex = match.index!;

  const endIndex =
    startIndex +
    'tag:'.length +
    getFullTagFromPosition(textContent, startIndex).length;

  const textNode = input.firstChild;

  if (!textNode) return;

  // Create a range covering the entire partial tag text.
  const range = document.createRange();
  range.setStart(textNode, startIndex);
  range.setEnd(textNode, endIndex);

  // Replace the partial tag with the full tag suggestion plus a trailing space if needed.
  range.deleteContents();
  const followingChar = textContent.charAt(endIndex);
  const trailing = followingChar === ' ' ? '' : ' ';
  const newTagText = `tag:${selectedTag}${trailing}`;
  const newTagNode = document.createTextNode(newTagText);
  range.insertNode(newTagNode);

  // Move the caret right after the inserted text.
  const newRange = document.createRange();
  newRange.setStartAfter(newTagNode);
  selection.removeAllRanges();
  selection.addRange(newRange);

  // Merge all text nodes that might have been created by inserting the new tag.
  input.normalize();
}

export const SearchbarInput: React.FC<SearchbarInputProps> = ({
  onQueryChange,
  onURLChange,
  customValue,
  inputRef,
  mutateText,
}) => {
  const [tagRect, setTagRect] = useState<DOMRect | undefined>();
  const [tagQueryValue, setTagQueryValue] = useState('');
  const tagList = useTagList();

  const filteredTagList = tagList.filter(t =>
    t.title.toLowerCase().includes(tagQueryValue.toLowerCase()),
  );

  const highlightAndFindTags = useTagHighlighting(inputRef, tagList);

  const onSelect = (index: number | undefined) => {
    if (index === undefined) return;

    const selectedTag = filteredTagList[index];

    if (!selectedTag || !inputRef.current) return;

    replacePartialTagWithFullTag(inputRef.current, selectedTag.title);

    const text = inputRef.current.textContent || '';

    // Recreate any ranges that where present before insertion.
    const foundTags = highlightAndFindTags(text.toLowerCase());

    onQueryChange(
      extractQueryFromText(text),
      foundTags.map(t => t.subject),
    );
  };

  const {
    selectedIndex,
    onKeyDown: onTagKeyDown,
    onMouseOver: onTagHover,
    onClick: onTagClick,
    resetIndex,
    usingKeyboard,
  } = useSelectedIndex(filteredTagList, onSelect);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (tagRect) {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
      }

      onTagKeyDown(e);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLDivElement>) => {
    if (!inputRef.current) return;

    let str = e.target.textContent ?? '';

    // For some reason a single <br /> tag is present when the user empties the input, we need to remove that so the placeholder is visible again.
    if (str === '') {
      e.target.childNodes.forEach(child => {
        child.remove();
      });
    }

    // Check if the user is entering an URL, if so, update the URL state.
    // 'tag:' is also technically a valid URL but we don't want to treat it as one.
    if (!str.startsWith('tag:') && isURL(str)) {
      onURLChange(str);

      return;
    }

    // Content-editable fields allow newlines in their text, we remove them manually.
    if (str.includes('\n')) {
      str = str.replaceAll('\n', '');
      mutateText(str);
    }

    const foundTags = highlightAndFindTags(str.toLowerCase());
    const finalQuery = extractQueryFromText(str);

    onQueryChange(
      finalQuery,
      foundTags.map(t => t.subject),
    );
  };

  const handleFocus = () => {
    if (!inputRef.current) return;

    const text = inputRef.current.textContent || '';

    // If the text is a url, select the whole text.
    if (isURL(text)) {
      const range = document.createRange();
      range.selectNodeContents(inputRef.current);
      const selection = window.getSelection();

      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  };

  // Check the position of the caret and update the tag rect and query value if the caret is in a tag.
  useEffect(() => {
    const onSelectionChange = () => {
      if (!inputRef.current) return;

      const tagAtCaret = getTagAtCaretPosition(inputRef.current);

      if (tagAtCaret) {
        setTagRect(tagAtCaret.rect);
        setTagQueryValue(tagAtCaret.tag);
      } else {
        setTagRect(undefined);
        setTagQueryValue('');
      }

      resetIndex();
    };

    document.addEventListener('selectionchange', onSelectionChange);

    return () => {
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);

  useEffect(() => {
    if (
      inputRef.current &&
      customValue !== undefined &&
      // We don't want to update the node if the value is already in there as that would cause the users cursor to jump to the start.
      inputRef.current.textContent !== customValue
    ) {
      mutateText(customValue);
    }
  }, [customValue]);

  useEffect(() => {
    if (!inputRef.current) return;

    return polyfillPlaintextOnly(inputRef.current);
  }, []);

  return (
    <>
      <SearchbarFakeInput
        ref={inputRef}
        contentEditable='plaintext-only'
        onKeyDown={handleKeyDown}
        onInput={handleChange}
        $placeholder='Enter an Atomic URL or search  (press "/")'
        role='searchbox'
        data-testid='adress-bar'
        autoCapitalize='off'
        aria-label='Search'
        onFocus={handleFocus}
      />
      <TagSuggestionOverlay
        startingRect={tagRect}
        tags={filteredTagList}
        onTagHover={onTagHover}
        onTagClick={onTagClick}
        selectedIndex={selectedIndex}
        usingKeyboard={usingKeyboard}
      />
    </>
  );
};

export const SearchbarFakeInput = styled.div<{ $placeholder: string }>`
  white-space: nowrap;
  overflow: hidden;
  padding-block: 0.4rem;
  padding-inline-start: 0rem;
  color: ${p => p.theme.colors.textLight};
  flex: 1;

  &:focus {
    color: ${p => p.theme.colors.text};
    outline: none;
  }

  &:empty::before {
    content: '${p => p.$placeholder}';
    pointer-events: none;
  }

  &::highlight(tag-highlight) {
    color: ${p => p.theme.colors.mainSelectedFg};
    background-color: ${p => p.theme.colors.mainSelectedBg};
    padding: 0.2rem;
    display: inline-block;
  }
`;
