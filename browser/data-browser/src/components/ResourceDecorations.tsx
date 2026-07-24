import {
  Image,
  core,
  dataBrowser,
  useArray,
  useCanWrite,
  useString,
  useSubject,
  type Resource,
} from '@tomic/react';
import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react';
import { styled, css } from 'styled-components';
import * as RadixPopover from '@radix-ui/react-popover';
import { FaFaceSmile, FaImage } from 'react-icons/fa6';
import { EmojiInput } from './forms/EmojiInput';
import { FilePickerDialog } from './forms/FilePicker/FilePickerDialog';
import { useUpload } from '../hooks/useUpload';
import { atomicArgu } from '../ontologies/atomic-argu';
import { Button } from './Button';
import { Column, Row } from './Row';
import { ErrorBoundary } from '../views/ErrorPage';
import { Dialog, DialogContent, DialogTitle, useDialog } from './Dialog';
import { AvatarCropper } from './AvatarCropper';
import { ResourceGlyph } from './ResourceGlyph';
import { errorHandler } from '../handlers/errorHandler';

const EmojiPickerPanelAsync = lazy(() =>
  import('../chunks/EmojiInput/EmojiInput').then(m => ({
    default: m.EmojiPickerPanel,
  })),
);

// validate: false — the coverImage property is not (yet) resolvable at its
// canonical atomicdata.dev subject, so client-side datatype validation would
// fail on the fetch. The server validates commits against its local copy.
const valueOpts = {
  commit: true,
  validate: false,
};

/** Mimetypes the server can resize & re-encode, plus formats browsers render natively. */
const COVER_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/avif',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
]);

const NothingOnError = () => null;

/**
 * The resource's cover image value. Old Articles stored their cover under an
 * argu-specific property; reads fall back to it, writes migrate to the
 * canonical property.
 */
function useCoverImage(
  resource: Resource,
): [cover: string | undefined, applyCover: (subject?: string) => void] {
  const [cover, setCover] = useSubject(
    resource,
    dataBrowser.properties.coverImage,
    valueOpts,
  );
  const [legacyCover, setLegacyCover] = useSubject(
    resource,
    atomicArgu.properties.coverImage,
    valueOpts,
  );

  const applyCover = (subject?: string) => {
    setCover(subject);

    if (legacyCover) {
      setLegacyCover(undefined);
    }
  };

  return [cover ?? legacyCover, applyCover];
}

interface CoverPickerProps {
  resource: Resource;
  show: boolean;
  onShowChange: (show: boolean) => void;
  onPicked: (subject: string) => void;
}

/** Pick-or-upload dialog for a cover image. */
function CoverPicker({
  resource,
  show,
  onShowChange,
  onPicked,
}: CoverPickerProps): JSX.Element {
  const { upload } = useUpload(resource);

  const handleNewFilePicked = async (file: File) => {
    const [subject] = await upload([file]);

    if (subject) {
      onPicked(subject);
    }
  };

  return (
    <FilePickerDialog
      show={show}
      onShowChange={onShowChange}
      onResourcePicked={onPicked}
      onNewFilePicked={handleNewFilePicked}
      allowedMimes={COVER_MIMES}
    />
  );
}

export interface ResourceDecorationProps {
  resource: Resource;
}

/**
 * Full-bleed cover image banner. Mount directly under the page's Main, above
 * the padded content container, so it touches the edges.
 */
export function ResourceCoverImage({
  resource,
}: ResourceDecorationProps): JSX.Element | null {
  const canEdit = useCanWrite(resource);
  const [cover, applyCover] = useCoverImage(resource);
  const [showPicker, setShowPicker] = useState(false);

  if (!cover) {
    return null;
  }

  return (
    <CoverWrapper>
      <ErrorBoundary FallBackComponent={NothingOnError}>
        <CoverImage subject={cover} alt='' sizeIndication={100} />
      </ErrorBoundary>
      {canEdit && (
        <>
          <CoverActions gap='0.5rem'>
            <Button subtle onClick={() => setShowPicker(true)}>
              Change cover
            </Button>
            <Button subtle onClick={() => applyCover(undefined)}>
              Remove cover
            </Button>
          </CoverActions>
          <CoverPicker
            resource={resource}
            show={showPicker}
            onShowChange={setShowPicker}
            onPicked={applyCover}
          />
        </>
      )}
    </CoverWrapper>
  );
}

/**
 * The upload-an-image flow for the icon slot: pick a file → crop/zoom in the
 * AvatarCropper → bake a small square webp client-side → upload → set `icon`
 * (which replaces any emoji).
 *
 * Returns `openImagePicker` (opens the native file chooser) and `elements`
 * to mount: an always-mounted hidden file input plus the cropper dialog.
 * The input deliberately lives OUTSIDE any popover — opening the native
 * chooser dismisses popovers, and a file picked into an unmounted input is
 * silently dropped.
 */
function useIconImageUpload(resource: Resource) {
  const { upload } = useUpload(resource);
  const [, setIconImage] = useSubject(
    resource,
    dataBrowser.properties.icon,
    valueOpts,
  );
  const [, setEmoji] = useString(
    resource,
    dataBrowser.properties.emoji,
    valueOpts,
  );
  const [isA] = useArray(resource, core.properties.isA);
  const [pendingFile, setPendingFile] = useState<File>();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const openImagePicker = () => inputRef.current?.click();

  const handleCropped = async (cropped: File) => {
    // Upload failures toast via useUpload's own errorHandler.
    const [subject] = await upload([cropped]);

    if (!subject) {
      return;
    }

    try {
      await setIconImage(subject);
      await setEmoji(undefined);
    } catch (e) {
      errorHandler(e as Error);
    }
  };

  const elements = (
    <>
      <HiddenFileInput
        ref={inputRef}
        type='file'
        accept='image/*'
        onChange={e => {
          const file = e.currentTarget.files?.[0];

          if (file) {
            setPendingFile(file);
          }

          // Allow re-picking the same file.
          e.currentTarget.value = '';
        }}
      />
      {pendingFile && (
        <AvatarCropper
          file={pendingFile}
          show
          circle={isA.includes(core.classes.agent)}
          onShowChange={open => {
            if (!open) {
              setPendingFile(undefined);
            }
          }}
          onCropped={handleCropped}
        />
      )}
    </>
  );

  return { openImagePicker, elements };
}

/**
 * The resource's icon (emoji or avatar image), rendered inline at title
 * size. Clicking it opens the picker (when the user can edit). Rendered by
 * EditableTitle.
 */
export function TitleIcon({
  resource,
}: ResourceDecorationProps): JSX.Element | null {
  const canEdit = useCanWrite(resource);
  const [emoji, setEmoji] = useString(
    resource,
    dataBrowser.properties.emoji,
    valueOpts,
  );
  const [iconImage, setIconImage] = useSubject(
    resource,
    dataBrowser.properties.icon,
    valueOpts,
  );
  const { openImagePicker, elements } = useIconImageUpload(resource);

  if (!emoji && !iconImage) {
    return null;
  }

  const display = <ResourceGlyph resource={resource} requireCustom />;

  if (!canEdit) {
    return <StaticGlyph aria-hidden>{display}</StaticGlyph>;
  }

  return (
    <>
      <EmojiInput
        key={resource.subject}
        initialValue={emoji}
        showRemove
        onUploadImage={openImagePicker}
        onChange={value => {
          // Picking an emoji replaces an image icon; Remove clears both.
          setEmoji(value);
          setIconImage(undefined);
        }}
        Trigger={
          <GlyphTrigger title='Change icon' onClick={e => e.stopPropagation()}>
            {display}
          </GlyphTrigger>
        }
      />
      {/* This fragment renders INSIDE the click-to-edit page title (h1).
          The cropper's native <dialog> escapes it visually but not in the
          DOM tree, so its clicks (Save, drag, slider) would bubble into the
          title and flip it into editing mode. Fence them off. */}
      <ClickFence onClick={e => e.stopPropagation()}>{elements}</ClickFence>
    </>
  );
}

/**
 * Ghost "Add icon" / "Add cover" buttons, revealed when hovering the title
 * area. Rendered by EditableTitle when `withDecorations` is set.
 */
export function TitleDecorationAffordances({
  resource,
}: ResourceDecorationProps): JSX.Element | null {
  const canEdit = useCanWrite(resource);
  const [emoji, setEmoji] = useString(
    resource,
    dataBrowser.properties.emoji,
    valueOpts,
  );
  const [iconImage] = useSubject(resource, dataBrowser.properties.icon);
  const [cover, applyCover] = useCoverImage(resource);
  const [showPicker, setShowPicker] = useState(false);
  const { openImagePicker, elements } = useIconImageUpload(resource);

  const hasIcon = !!(emoji || iconImage);

  if (!canEdit || (hasIcon && cover)) {
    return null;
  }

  return (
    <>
      <AffordanceRow gap='0.5rem'>
        {!hasIcon && (
          <EmojiInput
            key={resource.subject}
            onChange={setEmoji}
            onUploadImage={openImagePicker}
            Trigger={
              <AffordanceTrigger>
                <FaFaceSmile aria-hidden /> Add icon
              </AffordanceTrigger>
            }
          />
        )}
        {!cover && (
          <AffordanceButton onClick={() => setShowPicker(true)}>
            <FaImage aria-hidden /> Add cover
          </AffordanceButton>
        )}
      </AffordanceRow>
      {!cover && (
        <CoverPicker
          resource={resource}
          show={showPicker}
          onShowChange={setShowPicker}
          onPicked={applyCover}
        />
      )}
      {elements}
    </>
  );
}

interface PickerDialogProps {
  resource: Resource;
  show: boolean;
  onShowChange: (show: boolean) => void;
}

/** Emoji picker in a dialog, for surfaces without an anchor (the ⌘M menu). */
export function EmojiPickerDialog({
  resource,
  show,
  onShowChange,
}: PickerDialogProps): JSX.Element {
  const [emoji, setEmoji] = useString(
    resource,
    dataBrowser.properties.emoji,
    valueOpts,
  );
  const [iconImage, setIconImage] = useSubject(
    resource,
    dataBrowser.properties.icon,
    valueOpts,
  );
  const { openImagePicker, elements } = useIconImageUpload(resource);
  const [dialogProps, showDialog, closeDialog] = useDialog({
    bindShow: onShowChange,
  });

  useEffect(() => {
    if (show) {
      showDialog();
    }
  }, [show, showDialog]);

  return (
    <>
      <Dialog {...dialogProps}>
        {show && (
          <>
            <DialogTitle>
              <h1>Icon</h1>
            </DialogTitle>
            <DialogContent>
              <Column>
                <Row justify='flex-end' gap='0.5rem'>
                  <Button
                    subtle
                    onClick={() => {
                      closeDialog(true);
                      openImagePicker();
                    }}
                  >
                    <FaImage aria-hidden /> Upload image
                  </Button>
                  {(emoji || iconImage) && (
                    <Button
                      subtle
                      onClick={() => {
                        setEmoji(undefined);
                        setIconImage(undefined);
                        closeDialog(true);
                      }}
                    >
                      Remove icon
                    </Button>
                  )}
                </Row>
                <Suspense fallback={null}>
                  <EmojiPickerPanelAsync
                    onEmojiSelect={e => {
                      setEmoji(e.native);
                      setIconImage(undefined);
                      closeDialog(true);
                    }}
                  />
                </Suspense>
              </Column>
            </DialogContent>
          </>
        )}
      </Dialog>
      {elements}
    </>
  );
}

/** Cover pick-or-upload dialog, for surfaces without an anchor (the ⌘M menu). */
export function CoverPickerDialog({
  resource,
  show,
  onShowChange,
}: PickerDialogProps): JSX.Element {
  const [, applyCover] = useCoverImage(resource);

  return (
    <CoverPicker
      resource={resource}
      show={show}
      onShowChange={onShowChange}
      onPicked={applyCover}
    />
  );
}

const HiddenFileInput = styled.input`
  display: none;
`;

/** Boxless wrapper that keeps descendant clicks from bubbling further. */
const ClickFence = styled.span`
  display: contents;
`;

const CoverWrapper = styled.div`
  position: relative;
  width: 100%;
  flex-shrink: 0;
`;

// The className ends up on the inner <img> element, so style it directly.
const CoverImage = styled(Image)`
  display: block;
  object-fit: cover;
  width: 100%;
  height: clamp(10rem, 25vh, 18rem);
`;

const CoverActions = styled(Row)`
  position: absolute;
  top: ${p => p.theme.size()};
  right: ${p => p.theme.size()};
  opacity: 0;
  transition: opacity 0.1s ease-in-out;

  ${CoverWrapper}:hover &,
  ${CoverWrapper}:focus-within & {
    opacity: 1;
  }

  & button {
    background-color: ${p => p.theme.colors.bg};
  }
`;

const glyphStyles = css`
  font-size: 1em;
  line-height: 1;
`;

const StaticGlyph = styled.span`
  ${glyphStyles}
`;

const GlyphTrigger = styled(RadixPopover.Trigger)`
  ${glyphStyles}
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  border-radius: ${p => p.theme.radius};
  transition: transform 0.1s ease-in-out;

  &:hover,
  &:focus-visible {
    transform: scale(1.1);
  }
`;

const affordanceStyles = css`
  display: inline-flex;
  align-items: center;
  gap: 0.5ch;
  border: none;
  background: transparent;
  padding: 0.3rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  font-weight: normal;
  cursor: pointer;

  &:hover,
  &:focus-visible {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => p.theme.colors.text};
  }
`;

const AffordanceTrigger = styled(RadixPopover.Trigger)`
  ${affordanceStyles}
`;

const AffordanceButton = styled.button`
  ${affordanceStyles}
`;

/**
 * Hidden until the title area is hovered or the buttons are focused.
 * EditableTitle's wrapper reveals it via a hover rule.
 */
export const AffordanceRow = styled(Row)`
  min-height: 2rem;
  opacity: 0;
  transition: opacity 0.1s ease-in-out;

  &:focus-within {
    opacity: 1;
  }
`;
