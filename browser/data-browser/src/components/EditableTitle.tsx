import {
  Resource,
  StoreEvents,
  useCanWrite,
  useStore,
  useTitle,
} from '@tomic/react';
import { useEffect, useRef, useState, type JSX } from 'react';
import { FaPencil } from 'react-icons/fa6';
import { styled, css } from 'styled-components';
import {
  PAGE_TITLE_TRANSITION_TAG,
  transitionName,
} from '../helpers/transitionName';
import { ViewTransitionProps } from '../helpers/ViewTransitionProps';
import { UnsavedIndicator } from './UnsavedIndicator';
import { Flex } from './Row';

export interface EditableTitleProps {
  resource: Resource;
  /** Uses `name` by default */
  parentRef?: React.RefObject<HTMLInputElement | null>;
  id?: string;
  className?: string;
  /** Called when the user commits the title (Enter or blur) */
  onCommit?: () => void;
}

const opts = {
  commit: true,
  validate: false,
};

export function EditableTitle({
  resource,
  parentRef,
  id,
  className,
  onCommit,
  ...props
}: EditableTitleProps): JSX.Element {
  const store = useStore();

  const [text, setText] = useTitle(resource, Infinity, opts);
  const [isEditing, setIsEditing] = useState(false);
  const innerRef = useRef<HTMLInputElement>(null);
  const ref = parentRef || innerRef;

  const canEdit = useCanWrite(resource);

  useEffect(() => {
    // Two ways to learn this resource was just manually created:
    //   1. The flag set synchronously by notifyResourceManuallyCreated, in
    //      case the event already fired before this component subscribed
    //      (the navigate-then-emit race).
    //   2. The event itself, for the live case where creation happens while
    //      this component is already mounted.
    if (store.consumeRecentlyCreated(resource.subject)) {
      setIsEditing(true);
    }

    return store.on(StoreEvents.ResourceManuallyCreated, created => {
      if (created.subject === resource.subject) {
        setIsEditing(true);
      }
    });
  }, [store, resource.subject]);

  function handleClick() {
    setIsEditing(true);
  }

  const placeholder = canEdit ? 'Set a title' : 'Untitled';

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, [isEditing]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setIsEditing(false);
      onCommit?.();
    } else if (e.key === 'Escape') {
      setIsEditing(false);
    }
  };

  return isEditing ? (
    <TitleInput
      ref={ref}
      data-testid='editable-title'
      type='text'
      {...props}
      onFocus={handleClick}
      placeholder={placeholder}
      onChange={e => setText(e.target.value)}
      value={text || ''}
      onKeyDown={handleKeyDown}
      onBlur={() => {
        setIsEditing(false);
        onCommit?.();
      }}
      className={className}
    />
  ) : (
    <Title
      disabled={!canEdit}
      id={id}
      canEdit={!!canEdit}
      title={canEdit ? 'Click to edit title' : ''}
      data-testid='editable-title'
      onClick={handleClick}
      subtle={!!canEdit && !text}
      subject={resource.subject}
      className={className}
    >
      <>
        <span>
          {text || placeholder}
          <UnsavedIndicator resource={resource} />
        </span>
        {canEdit && <Icon />}
      </>
    </Title>
  );
}

const TitleShared = css`
  line-height: 1.1;
`;

interface TitleProps {
  subtle: boolean;
  canEdit: boolean;
  disabled: boolean;
}

const Title = styled.h1<TitleProps & ViewTransitionProps>`
  ${TitleShared}
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size()};
  cursor: ${props => (props.canEdit ? 'pointer' : 'initial')};
  opacity: ${props => (props.subtle ? 0.5 : 1)};

  ${props => transitionName(PAGE_TITLE_TRANSITION_TAG, props.subject)};
`;

const TitleInput = styled.input`
  ${TitleShared}
  margin-bottom: ${props => props.theme.margin}rem;
  font-size: ${p => p.theme.fontSizeH1}rem;
  color: ${p => p.theme.colors.text};
  border: none;
  font-weight: bold;
  display: block;
  padding: 0;
  margin-top: 0;
  outline: none;
  background-color: transparent;
  margin-bottom: ${p => p.theme.margin}rem;
  font-family: ${p => p.theme.fontFamilyHeader};
  word-wrap: break-word;
  word-break: break-all;
  overflow: visible;

  &:focus {
    outline: none;
  }

  ${Flex} & {
    // When rendered inside a flex container the margin is already provided by the gap.
    margin-bottom: 0;
  }
`;

const Icon = styled(FaPencil)`
  opacity: 0;
  font-size: 0.8em;
  ${Title}:hover & {
    opacity: 0.5;
  }
`;
