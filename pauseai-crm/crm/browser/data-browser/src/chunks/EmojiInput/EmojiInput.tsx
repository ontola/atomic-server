import { useCallback, useState, type JSX, type ReactNode } from 'react';
import Picker from '@emoji-mart/react';
import { styled, useTheme } from 'styled-components';
import * as RadixPopover from '@radix-ui/react-popover';
import { FaFolderOpen, FaImage, FaTrash } from 'react-icons/fa6';
import { transition } from '../../helpers/transition';
import { Popover } from '../../components/Popover';

export interface EmojiInputProps {
  initialValue?: string;
  onChange: (value: string | undefined) => void;
  /**
   * Custom popover trigger (must be a RadixPopover.Trigger element).
   * Defaults to a small button showing the current emoji.
   */
  Trigger?: ReactNode;
  /**
   * Offers an "Upload image" option for image icons/avatars. Called with no
   * arguments — the caller opens its own (always-mounted) file input. The
   * input must NOT live inside this popover: opening the native file chooser
   * dismisses the popover, and a file picked into an unmounted input is
   * silently dropped.
   */
  onUploadImage?: () => void;
  /**
   * Offers a "Pick existing" option for image icons/avatars, reusing the
   * same file-search dialog covers use. Called with no arguments — the
   * caller owns its own (always-mounted) dialog, for the same reason as
   * `onUploadImage`: closing this popover unmounts its contents.
   */
  onPickExisting?: () => void;
  /**
   * Force the remove option to show (e.g. when an image icon is set, which
   * this component doesn't know about).
   */
  showRemove?: boolean;
}

const EMOJI_DATA_URL = 'https://cdn.jsdelivr.net/npm/@emoji-mart/data';

let data: Promise<unknown>;

const fetchAndCacheData = async () => {
  if (data) {
    return data;
  }

  const response = await fetch(EMOJI_DATA_URL);
  data = response.json();

  return data;
};

export interface EmojiPickerPanelProps {
  onEmojiSelect: (e: { native: string }) => void;
}

/** The bare emoji-mart picker, for embedding outside the popover (dialogs). */
export function EmojiPickerPanel({
  onEmojiSelect,
}: EmojiPickerPanelProps): JSX.Element {
  return (
    <PickerWrapper>
      <Picker
        autoFocus
        data={fetchAndCacheData}
        onEmojiSelect={onEmojiSelect}
        maxFrequentRows={2}
        dynamicWidth={true}
      />
    </PickerWrapper>
  );
}

export default function EmojiInputASYNC({
  initialValue,
  onChange,
  Trigger,
  onUploadImage,
  onPickExisting,
  showRemove,
}: EmojiInputProps): JSX.Element {
  const theme = useTheme();
  const [showPicker, setShowPicker] = useState(false);
  const [emoji, setEmoji] = useState<string | undefined>(initialValue);

  const handleEmojiSelect = useCallback(
    (e: { native: string }) => {
      setEmoji(e.native);
      setShowPicker(false);
      onChange(e.native);
    },
    [onChange],
  );

  const handleRemove = useCallback(() => {
    setEmoji(undefined);
    setShowPicker(false);
    onChange(undefined);
  }, [onChange]);

  return (
    <PickerPopover
      noArrow
      open={showPicker}
      onOpenChange={setShowPicker}
      Trigger={
        Trigger ?? (
          <PickerButton
            onClick={() => setShowPicker(true)}
            title='Pick an emoji'
          >
            {emoji ? <Preview>{emoji}</Preview> : <Placeholder>😎</Placeholder>}
          </PickerButton>
        )
      }
    >
      <PickerWrapper>
        {(emoji || showRemove || onUploadImage || onPickExisting) && (
          <HeaderRow>
            {onUploadImage && (
              <HeaderButton
                type='button'
                onClick={() => {
                  setShowPicker(false);
                  onUploadImage();
                }}
              >
                <FaImage aria-hidden /> Upload image
              </HeaderButton>
            )}
            {onPickExisting && (
              <HeaderButton
                type='button'
                onClick={() => {
                  setShowPicker(false);
                  onPickExisting();
                }}
              >
                <FaFolderOpen aria-hidden /> Pick existing
              </HeaderButton>
            )}
            {(emoji || showRemove) && (
              <HeaderButton type='button' onClick={handleRemove}>
                <FaTrash aria-hidden /> Remove
              </HeaderButton>
            )}
          </HeaderRow>
        )}
        <Picker
          autoFocus
          data={fetchAndCacheData}
          onEmojiSelect={handleEmojiSelect}
          maxFrequentRows={2}
          dynamicWidth={true}
          theme={theme.darkMode ? 'dark' : 'light'}
        />
      </PickerWrapper>
    </PickerPopover>
  );
}

const Preview = styled.span`
  will-change: font-size;
  ${transition('font-size')};
`;

const Placeholder = styled(Preview)`
  opacity: 0.5;
`;

const PickerButton = styled(RadixPopover.Trigger)`
  border: none;
  border-radius: ${({ theme }) => theme.radius};
  width: 2rem;
  height: 2rem;
  background: transparent;
  padding: 0;
  cursor: pointer;
  user-select: none;

  &:hover > ${Preview} {
    font-size: 1.3rem;
  }
`;

const PickerPopover = styled(Popover)`
  top: 200px;
`;

const PickerWrapper = styled.div`
  display: flex;
  flex-direction: column;

  & em-emoji-picker {
    height: 400px;
    width: min(90vw, 20rem);
  }
`;

const HeaderRow = styled.div`
  display: flex;
  justify-content: flex-end;
  gap: ${p => p.theme.size(1)};
  padding: ${p => p.theme.size(2)};
  padding-bottom: ${p => p.theme.size(1)};
`;

/** Quiet toolbar buttons so the picker itself stays the focal point. */
const HeaderButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  border: none;
  background: transparent;
  padding: 0.3rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  cursor: pointer;

  & svg {
    font-size: 0.8em;
  }

  &:hover,
  &:focus-visible {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;
