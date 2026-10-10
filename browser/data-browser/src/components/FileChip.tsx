import { FaXmark } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { formatBytes } from '../helpers/formatBytes';
import { getFileIcon } from '../helpers/filetypes';
import { IconButton } from './IconButton/IconButton';
import { Spinner } from './Spinner';

export interface FileChipProps {
  name: string;
  /** Size in bytes. */
  size?: number;
  mimeType?: string;
  /** Swaps the icon for a spinner: the file is being read or sent. */
  busy?: boolean;
  /** Makes the whole chip a button, e.g. to download the file. */
  onClick?: () => void;
  /** Adds a remove button, e.g. for a file that is not sent yet. */
  onRemove?: () => void;
  /** Shown under the name, e.g. why the file could not be opened. */
  note?: string;
}

/**
 * A file as one compact line: icon, name and size. Presentational, so it works
 * for a file about to be sent and for one that was received.
 */
export function FileChip({
  name,
  size,
  mimeType,
  busy,
  onClick,
  onRemove,
  note,
}: FileChipProps) {
  const Icon = getFileIcon(mimeType ?? '');
  const content = (
    <>
      <IconSlot aria-hidden>
        {busy ? <Spinner size='1em' /> : <Icon />}
      </IconSlot>
      <Text>
        <Name>{name}</Name>
        {size !== undefined && <Meta>{formatBytes(size)}</Meta>}
        {note && <Note role='status'>{note}</Note>}
      </Text>
    </>
  );

  return (
    <Chip>
      {onClick ? (
        <Main type='button' onClick={onClick} disabled={busy} title={name}>
          {content}
        </Main>
      ) : (
        <Static title={name}>{content}</Static>
      )}
      {onRemove && (
        <IconButton title='Remove file' type='button' onClick={onRemove}>
          <FaXmark />
        </IconButton>
      )}
    </Chip>
  );
}

const Chip = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: min(100%, 22rem);
  padding-right: 0.25rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  font-size: 0.85rem;
`;

const rowStyles = `
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding: 0.35rem 0.25rem 0.35rem 0.6rem;
`;

const Main = styled.button`
  ${rowStyles}
  border: none;
  border-radius: ${p => p.theme.radius};
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;

  &:hover:not(:disabled),
  &:focus-visible {
    background: ${p => p.theme.colors.bg1};
  }

  &:disabled {
    cursor: progress;
  }
`;

const Static = styled.div`
  ${rowStyles}
`;

const IconSlot = styled.span`
  display: inline-flex;
  flex-shrink: 0;
  color: ${p => p.theme.colors.textLight};
`;

const Text = styled.span`
  display: flex;
  flex-direction: column;
  min-width: 0;
`;

const Name = styled.span`
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.75rem;
`;

const Note = styled.span`
  color: ${p => p.theme.colors.alert};
  font-size: 0.75rem;
`;
