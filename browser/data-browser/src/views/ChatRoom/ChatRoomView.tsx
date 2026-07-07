import {
  commits,
  core,
  dataBrowser,
  Resource,
  Store,
  useCanWrite,
  useCollection,
  useCreatedAt,
  useCreatedBy,
  useResource,
  useStore,
  useString,
  useSubject,
} from '@tomic/react';
import { memo, useCallback, useRef, useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import {
  FaCopy,
  FaLink,
  FaMessage,
  FaPencil,
  FaReply,
  FaXmark,
} from 'react-icons/fa6';
import { styled } from 'styled-components';
import { AtomicLink } from '../../components/AtomicLink';
import { Button } from '../../components/Button';
import { ChatMessagesContainer } from '../../components/ChatMessagesContainer';
import { CommitDetail } from '../../components/CommitDetail';
import Markdown from '../../components/datatypes/Markdown';
import { Detail } from '../../components/Detail';
import { LoaderInline } from '../../components/Loader';
import { editURL } from '../../helpers/navigation';
import { ResourceInline } from '../ResourceInline';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

const CHAT_PAGE_SIZE = 50;

export interface ChatViewProps {
  messages: string[];
  loading: boolean;
  /** Persists a message. Throwing restores the composer text and shows the error. */
  onSend: (text: string, replyTo?: string) => Promise<void>;
  /** Pass a ref to control composer focus from outside (e.g. after a title edit). */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Presentational chat: message list, reply state and composer. Data comes in
 * via props so it also works before a chat resource exists (e.g. the Comments
 * panel creates the discussion on the first send).
 */
export function ChatView({
  messages,
  loading: messagesLoading,
  onSend,
  inputRef: inputRefProp,
}: ChatViewProps) {
  const [newMessageVal, setNewMessage] = useState('');
  const [isReplyTo, setReplyTo] = useState<string | undefined>(undefined);
  const internalInputRef = useRef<HTMLTextAreaElement>(null);
  const inputRef = inputRefProp ?? internalInputRef;
  const [textAreaHight, setTextAreaHight] = useState(1);
  const [scrollToBottomTrigger, setScrollToBottomTrigger] = useState(0);

  const disableSend = newMessageVal.length === 0;

  const sendMessage = async (e?: React.SyntheticEvent) => {
    e?.preventDefault();

    if (disableSend) {
      return;
    }

    const messageBackup = newMessageVal;

    try {
      setScrollToBottomTrigger(prev => prev + 1);
      setNewMessage('');
      await onSend(messageBackup, isReplyTo);
      setReplyTo(undefined);
    } catch (err) {
      setNewMessage(messageBackup);
      toast.error(err.message);
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  };

  const handleReply = useCallback(
    (subject: string) => {
      setReplyTo(subject);
      inputRef.current?.focus();
    },
    [setReplyTo, inputRef],
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
    <ViewWrapper>
      <ScrollAreaWrapper>
        <ChatMessagesContainer
          enableAutoScroll
          scrollToBottomTrigger={scrollToBottomTrigger}
        >
          {messagesLoading ? (
            <LoaderInline>Loading messages...</LoaderInline>
          ) : messages.length === 0 ? (
            <EmptyChatState>
              <FaMessage />
              <p>No messages yet</p>
              <span>Be the first to say something</span>
            </EmptyChatState>
          ) : (
            messages.map(message => (
              <Message
                key={message}
                subject={message}
                setReplyTo={handleReply}
              />
            ))
          )}
        </ChatMessagesContainer>
      </ScrollAreaWrapper>
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
          onKeyDown={handleKeyDown}
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
    </ViewWrapper>
  );
}

export interface ChatRoomViewProps {
  resource: Resource;
  /** Pass a ref to control composer focus from outside (e.g. after a title edit). */
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

/**
 * Message list and composer for an existing ChatRoom. Used by the full-page
 * ChatRoom view and the Comments panel.
 */
export function ChatRoomView({ resource, inputRef }: ChatRoomViewProps) {
  const store = useStore();
  const { messages, loading, invalidate } = useChatMessages(resource.subject);

  const handleSend = async (text: string, replyTo?: string) => {
    await sendChatMessage(store, { parent: resource.subject, text, replyTo });
    invalidate();
  };

  return (
    <ChatView
      messages={messages}
      loading={loading}
      onSend={handleSend}
      inputRef={inputRef}
    />
  );
}

interface SendChatMessageOptions {
  /** Rights/lifecycle anchor: the ChatRoom, or e.g. the drive's Comments folder for comments. */
  parent: string;
  text: string;
  /** For comments: the resource this message is about. The comment thread of a resource is the set of Messages with `about` pointing to it. */
  about?: string;
  replyTo?: string;
}

/** Creates and saves a Message resource. */
export async function sendChatMessage(
  store: Store,
  { parent, text, about, replyTo }: SendChatMessageOptions,
) {
  const msgResource = await store.newResource({
    parent,
    isA: dataBrowser.classes.message,
    propVals: {
      [core.properties.description]: text,
      // `createdAt` is NOT set here: it's derived from the genesis Loro
      // change (timestamp) and materialized server-side. Authoring it
      // explicitly is now rejected by the server.
      ...(about && {
        [dataBrowser.properties.about]: about,
      }),
      ...(replyTo && {
        [dataBrowser.properties.replyTo]: replyTo,
      }),
    },
  });

  await msgResource.save();
  store.notifyResourceManuallyCreated(msgResource);
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
  // Creation date + creator come from the genesis change in the resource's own
  // Loro oplog (materialized into propvals) — no commit fetch, so they survive
  // a refresh. The commit subject is intentionally NOT passed.
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);
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
        <CommitDetail createdAt={createdAt} createdBy={createdBy} />
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
  // Author from the resource's own genesis metadata (createdBy) — not a commit
  // fetch, so it survives a refresh.
  const author = useCreatedBy(resource);

  if (!resource.isReady()) {
    return <MessageLineStyled>loading...</MessageLineStyled>;
  }

  // truncate and add ellipsis
  const truncated = description?.substring(0, MESSAGE_LINE_MAX_LEN);
  const ellipsis =
    description && description.length > MESSAGE_LINE_MAX_LEN ? '...' : '';

  return (
    <MessageLineStyled>
      <span>to </span>
      {author && <ResourceInline subject={author} />}
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

const ViewWrapper = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: ${p => p.theme.size(2)};
`;

const ScrollAreaWrapper = styled.div`
  flex: 1;
  min-height: 0;
`;

const EmptyChatState = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.4rem;
  padding-block: 4rem;
  color: ${p => p.theme.colors.textLight};
  opacity: 0.5;

  & > svg {
    font-size: 2.5rem;
    margin-bottom: 0.5rem;
  }

  & > p {
    margin: 0;
    font-size: 1rem;
    font-weight: 500;
  }

  & > span {
    font-size: 0.8rem;
  }
`;

/**
 * Fetches messages linked to a subject using the Collection system, sorted by
 * createdAt ascending (oldest first) with pagination. ChatRooms link their
 * messages via `parent` (the default); comment threads via `about`.
 */
export function useChatMessages(
  subject: string,
  property: string = core.properties.parent,
) {
  const [messages, setMessages] = useState<string[]>([]);

  const { collection, ready, invalidateCollection } = useCollection(
    {
      property,
      value: subject,
      sort_by: commits.properties.createdAt,
      sort_desc: false,
    },
    { pageSize: CHAT_PAGE_SIZE },
  );

  useEffect(() => {
    const extractMembers = async () => {
      await collection.waitForReady();
      const members: string[] = [];

      for (let i = 0; i < collection.totalMembers; i++) {
        const member = await collection.getMemberWithIndex(i);

        if (member) {
          members.push(member);
        }
      }

      setMessages(members);
    };

    extractMembers();
  }, [collection]);

  // `useCollection` (used internally by this hook) routes
  // `ResourceManuallyCreated` through `applyResourceChange` for an
  // optimistic append — sent messages appear instantly without a
  // server round-trip.

  return {
    messages,
    loading: !ready,
    invalidate: invalidateCollection,
  };
}
