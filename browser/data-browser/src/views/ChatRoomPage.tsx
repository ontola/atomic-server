import {
  commits,
  core,
  dataBrowser,
  getTimestampNow,
  useArray,
  useCanWrite,
  useResource,
  useStore,
  useString,
  useSubject,
} from '@tomic/react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useHotkeys } from 'react-hotkeys-hook';
import { FaCopy, FaLink, FaPencil, FaReply, FaXmark } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { AtomicLink } from '../components/AtomicLink';
import { Button } from '../components/Button';
import { CommitDetail } from '../components/CommitDetail';
import Markdown from '../components/datatypes/Markdown';
import { Detail } from '../components/Detail';
import { EditableTitle } from '../components/EditableTitle';
import { NavBarSpacer } from '../components/NavBarSpacer';
import { editURL } from '../helpers/navigation';
import { ResourceInline } from './ResourceInline';
import { ResourcePageProps } from './ResourcePage';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

import { Column } from '../components/Row';

/** Full page ChatRoom that shows a message list and a form to add Messages. */
export function ChatRoomPage({ resource }: ResourcePageProps) {
  const [messages] = useArray(resource, dataBrowser.properties.messages);
  const [newMessageVal, setNewMessage] = useState('');
  const store = useStore();
  const [isReplyTo, setReplyTo] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [textAreaHight, setTextAreaHight] = useState(1);

  const shouldAutoScroll = useRef(true);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;

    shouldAutoScroll.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  };

  const disableSend = newMessageVal.length === 0;

  /** Creates a message using the internal state */
  const sendMessage = async (e?: React.SyntheticEvent) => {
    const messageBackup = newMessageVal;

    try {
      scrollToBottom();
      setNewMessage('');
      e?.preventDefault();

      if (!disableSend) {
        const msgResource = await store.newResource({
          parent: resource.subject,
          isA: dataBrowser.classes.message,
          propVals: {
            [core.properties.description]: newMessageVal,
            [commits.properties.createdAt]: getTimestampNow(),
            ...(isReplyTo && {
              [dataBrowser.properties.replyTo]: isReplyTo,
            }),
          },
        });

        await msgResource.save();
        setReplyTo(undefined);
      }
    } catch (err) {
      setNewMessage(messageBackup);
      toast.error(err.message);
    }
  };

  useHotkeys(
    'enter',
    e => {
      e.preventDefault();
      sendMessage();
    },
    { enableOnTags: ['TEXTAREA'] },
    [],
  );

  useHotkeys(
    'escape',
    _e => {
      inputRef?.current?.blur();
    },
    { enableOnTags: ['TEXTAREA'] },
    [],
  );
  // Scroll to bottom when new messages arrive, and re-enable auto-scroll
  useEffect(() => {
    shouldAutoScroll.current = true;
    scrollToBottom();
  }, [messages.length, resource]);

  // Continue scrolling as async message content loads and expands the container
  useEffect(() => {
    const content = scrollRef.current?.firstElementChild;
    if (!content) return;

    const observer = new ResizeObserver(() => {
      if (shouldAutoScroll.current) {
        scrollToBottom();
      }
    });

    observer.observe(content);

    return () => observer.disconnect();
  }, []);

  const handleReply = useCallback(
    (subject: string) => {
      setReplyTo(subject);
      inputRef?.current?.focus();
    },
    [setReplyTo],
  );

  const handleChangeMessageText: React.ChangeEventHandler<
    HTMLTextAreaElement
  > = e => {
    setNewMessage(e.target.value);

    if (e.target.value === '') {
      // Make the textarea small again when the user removed their message
      setTextAreaHight(1);

      return;
    }

    // Auto-grow the textarea
    const overflowStyle = e.target.style.overflow;
    e.target.style.overflow = 'scroll';
    // in Firefox, scrollHeight only works if overflow is set to scroll
    const height = e.target.scrollHeight;
    e.target.style.overflow = overflowStyle;
    const rowHeight = 30;
    const trows = Math.ceil(height / rowHeight) - 1;

    if (trows !== textAreaHight) {
      setTextAreaHight(trows);
    }
  };

  return (
    <FullPageWrapper>
      <Column fullHeight>
        <EditableTitle resource={resource} />
        <ScrollingContent ref={scrollRef} onScroll={handleScroll}>
          <MessagesPage subject={resource.subject} setReplyTo={handleReply} />
        </ScrollingContent>
        {isReplyTo && (
          <Detail>
            <MessageLine subject={isReplyTo} />
            <Button icon subtle onClick={() => setReplyTo(undefined)}>
              <FaXmark />
            </Button>
          </Detail>
        )}
        <MessageForm onSubmit={sendMessage}>
          <MessageInput
            aria-label='Chat input'
            rows={textAreaHight}
            ref={inputRef}
            autoFocus
            value={newMessageVal}
            onChange={handleChangeMessageText}
            placeholder={'type a message'}
          />
          <SendButton
            title='Send message [enter]'
            disabled={disableSend}
            clean
            onClick={() => sendMessage()}
          >
            Send
          </SendButton>
        </MessageForm>
        <NavBarSpacer baseMargin='2rem' position='bottom' />
      </Column>
    </FullPageWrapper>
  );
}

type SetReplyToType = (subject: string) => unknown;

interface MessageProps {
  subject: string;
  /** Is called when the `reply` button is pressed */
  setReplyTo: SetReplyToType;
}

/** How many characters are shown at max by default in a message */
const MESSAGE_MAX_LEN = 500;

/** Single message shown in a ChatRoom */
const Message = memo(function Message({ subject, setReplyTo }: MessageProps) {
  const resource = useResource(subject);
  const [description] = useString(resource, core.properties.description);
  const [lastCommit] = useSubject(resource, commits.properties.lastCommit);
  const [replyTo] = useSubject(resource, dataBrowser.properties.replyTo);
  const navigate = useNavigateWithTransition();
  const canWrite = useCanWrite(resource);

  function handleCopyUrl() {
    navigator.clipboard.writeText(subject);
    toast.success('Copied message URL to clipboard');
  }

  function handleCopyText() {
    navigator.clipboard.writeText(description || '');
    toast.success('Copied message text to clipboard');
  }

  return (
    <MessageComponent about={subject}>
      <MessageDetails>
        <CommitDetail commitSubject={lastCommit!} />
        {replyTo && <MessageLine subject={replyTo} />}
        <MessageActions>
          {canWrite && (
            <Button
              icon
              subtle
              onClick={() => navigate(editURL(subject))}
              title='Edit message'
            >
              <FaPencil />
            </Button>
          )}
          <Button
            icon
            subtle
            onClick={() => setReplyTo(subject)}
            title='Reply to this message'
          >
            <FaReply />
          </Button>
          <Button
            icon
            subtle
            onClick={handleCopyUrl}
            title='Copy link to this message'
          >
            <FaLink />
          </Button>
          <Button
            icon
            subtle
            onClick={handleCopyText}
            title='Copy message text'
          >
            <FaCopy />
          </Button>
        </MessageActions>
      </MessageDetails>
      <Markdown text={description || ''} maxLength={MESSAGE_MAX_LEN} />
    </MessageComponent>
  );
});

interface MessageLineProps {
  subject: string;
}

const MESSAGE_LINE_MAX_LEN = 50;

/** Small single line preview of a message, useful in replies */
function MessageLine({ subject }: MessageLineProps) {
  const resource = useResource(subject);
  const [description] = useString(resource, core.properties.description);
  const [lastCommit] = useSubject(resource, commits.properties.lastCommit);

  // Traverse path to find the author
  const commitResource = useResource(lastCommit);
  const [signer] = useSubject(commitResource, commits.properties.signer);

  if (!resource.isReady() || !commitResource.isReady()) {
    return <MessageLineStyled>loading...</MessageLineStyled>;
  }

  // truncate and add ellipsis
  const truncated = description?.substring(0, MESSAGE_LINE_MAX_LEN);
  const ellipsis =
    description && description.length > MESSAGE_LINE_MAX_LEN ? '...' : '';

  return (
    <MessageLineStyled>
      <span>to </span>
      <ResourceInline subject={signer!} />
      <AtomicLink subject={subject}>{`: ${truncated}${ellipsis}`}</AtomicLink>
    </MessageLineStyled>
  );
}

const MessageLineStyled = styled.span`
  font-size: 0.7rem;
  white-space: nowrap;
  overflow: hidden;
  flex: 1;
`;

/** Small row on top of Message for details such as date and creator */
const MessageDetails = styled.div`
  font-size: 0.7rem;
  margin-bottom: 0;
  opacity: 0.4;
  display: flex;
  gap: 1ch;
  flex: 1;
`;

/** Part of MessageDetails which is aligned to the right */
const MessageActions = styled.div`
  display: flex;
  align-self: flex-end;
  justify-content: flex-end;
  flex: 1;
  opacity: 0;
  gap: 0.5ch;
  margin-right: 1rem;
`;

const MessageComponent = styled.div`
  min-height: 1.5rem;
  padding-bottom: 0.5rem;
  padding-left: 1rem;

  &:hover {
    background: ${p => p.theme.colors.bg};

    & ${MessageDetails} {
      opacity: 1;
    }

    & ${MessageActions} {
      opacity: 1;
    }
  }
`;

const SendButton = styled(Button)`
  padding-left: 1rem;
  padding-right: 1rem;
  color: ${p => p.theme.colors.bg};
  background: ${p => p.theme.colors.main};

  &:disabled {
    cursor: default;
    display: auto;
    opacity: 0.5;
  }
`;

const MessageInput = styled.textarea`
  color: ${p => p.theme.colors.text};
  background: none;
  flex: 1;
  padding: 0.5rem 1rem;
  border: ${p => p.theme.colors.bg2} solid 1px;
  border-right: none;
  line-height: inherit;
  min-height: 2rem;
  max-height: 50vh;
  font-family: ${p => p.theme.fontFamily};
`;

/** Wrapper for the new message form */
const MessageForm = styled.form`
  display: flex;
  flex-basis: 3rem;
  flex-direction: row;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};

  view-transition-name: chat-input;

  > :first-child {
    border-top-left-radius: ${p => p.theme.radius};
    border-bottom-left-radius: ${p => p.theme.radius};
  }
  > :last-child {
    border-top-right-radius: ${p => p.theme.radius};
    border-bottom-right-radius: ${p => p.theme.radius};
  }
`;

const FullPageWrapper = styled.div`
  display: flex;
  flex-direction: column;
  /* I think this warrants a prettier solution */
  height: calc(100vh - 4rem);
  padding: 1rem;
  flex: 1;
`;

const ScrollingContent = styled.div`
  margin-left: -1rem;
  margin-right: -1rem;
  overflow-y: scroll;
  flex: 1;
`;

interface MessagesPageProps {
  subject: string;
  setReplyTo: SetReplyToType;
}

/** Shows Messages for this page. Recursively fetches the next page, if in view */
function MessagesPage({ subject, setReplyTo }: MessagesPageProps) {
  const resource = useResource(subject);
  const [messages] = useArray(resource, dataBrowser.properties.messages);
  const [nextPage] = useString(resource, dataBrowser.properties.nextPage);

  if (!resource.isReady()) {
    return <>loading...</>;
  }

  return (
    <div>
      {nextPage && <MessagesPage subject={nextPage} setReplyTo={setReplyTo} />}
      {messages.map(message => (
        <Message
          key={'message' + message}
          subject={message}
          setReplyTo={setReplyTo}
        />
      ))}
    </div>
  );
}
