import {
  Image,
  dataBrowser,
  useCanWrite,
  useString,
  useSubject,
  type Resource,
} from '@tomic/react';
import { lazy, Suspense, useEffect, useState, type JSX } from 'react';
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
 * The resource's emoji, rendered inline at title size. Clicking it opens the
 * picker (when the user can edit). Rendered by EditableTitle.
 */
export function TitleEmoji({
  resource,
}: ResourceDecorationProps): JSX.Element | null {
  const canEdit = useCanWrite(resource);
  const [emoji, setEmoji] = useString(
    resource,
    dataBrowser.properties.emoji,
    valueOpts,
  );

  if (!emoji) {
    return null;
  }

  if (!canEdit) {
    return <StaticGlyph aria-hidden>{emoji}</StaticGlyph>;
  }

  return (
    <EmojiInput
      key={resource.subject}
      initialValue={emoji}
      onChange={setEmoji}
      Trigger={
        <GlyphTrigger title='Change icon' onClick={e => e.stopPropagation()}>
          {emoji}
        </GlyphTrigger>
      }
    />
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
  const [cover, applyCover] = useCoverImage(resource);
  const [showPicker, setShowPicker] = useState(false);

  if (!canEdit || (emoji && cover)) {
    return null;
  }

  return (
    <>
      <AffordanceRow gap='0.5rem'>
        {!emoji && (
          <EmojiInput
            key={resource.subject}
            onChange={setEmoji}
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
  const [dialogProps, showDialog, closeDialog] = useDialog({
    bindShow: onShowChange,
  });

  useEffect(() => {
    if (show) {
      showDialog();
    }
  }, [show, showDialog]);

  return (
    <Dialog {...dialogProps}>
      {show && (
        <>
          <DialogTitle>
            <h1>Icon</h1>
          </DialogTitle>
          <DialogContent>
            <Column>
              {emoji && (
                <Row justify='flex-end'>
                  <Button
                    subtle
                    onClick={() => {
                      setEmoji(undefined);
                      closeDialog(true);
                    }}
                  >
                    Remove emoji
                  </Button>
                </Row>
              )}
              <Suspense fallback={null}>
                <EmojiPickerPanelAsync
                  onEmojiSelect={e => {
                    setEmoji(e.native);
                    closeDialog(true);
                  }}
                />
              </Suspense>
            </Column>
          </DialogContent>
        </>
      )}
    </Dialog>
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
