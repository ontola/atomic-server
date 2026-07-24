import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from './Dialog';
import { Button } from './Button';
import { Column, Row } from './Row';
import { resizeImageFile } from '../helpers/resizeImage';
import { errorHandler } from '../handlers/errorHandler';

const VIEWPORT = 280;
/** Output size of the baked avatar (crisp at 2x for the ≤64px render sizes). */
const OUTPUT_SIZE = 256;

export interface AvatarCropperProps {
  /** The original picked file; the crop is baked into a new small file. */
  file: File;
  show: boolean;
  onShowChange: (show: boolean) => void;
  onCropped: (file: File) => void;
  /**
   * Mask shape of the preview — must match how the icon will render:
   * circle for Agent avatars, squircle for everything else.
   */
  circle?: boolean;
}

/**
 * Frame an image before it becomes an icon/avatar: drag to position, slider
 * to zoom, circular mask preview. The result is baked client-side into a
 * small square WebP — this is a local-first app, so the stored file itself
 * must be small; there is no server resize endpoint to lean on.
 */
export function AvatarCropper({
  file,
  show,
  onShowChange,
  onCropped,
  circle,
}: AvatarCropperProps): JSX.Element {
  const [dialogProps, showDialog, closeDialog] = useDialog({
    bindShow: onShowChange,
  });

  const [url, setUrl] = useState<string>();
  const [size, setSize] = useState<{ w: number; h: number }>();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [saving, setSaving] = useState(false);
  const dragStart = useRef<
    { x: number; y: number; ox: number; oy: number } | undefined
  >(undefined);

  useEffect(() => {
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    setSize(undefined);

    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  useEffect(() => {
    if (show) {
      showDialog();
    }
  }, [show, showDialog]);

  // Scale at which the image exactly covers the viewport.
  const coverScale = size ? VIEWPORT / Math.min(size.w, size.h) : 1;
  const displayScale = coverScale * zoom;

  const clampOffset = useCallback(
    (o: { x: number; y: number }, atZoom: number) => {
      if (!size) {
        return o;
      }

      const scale = coverScale * atZoom;
      const maxX = Math.max(0, (size.w * scale - VIEWPORT) / 2);
      const maxY = Math.max(0, (size.h * scale - VIEWPORT) / 2);

      return {
        x: Math.min(maxX, Math.max(-maxX, o.x)),
        y: Math.min(maxY, Math.max(-maxY, o.y)),
      };
    },
    [size, coverScale],
  );

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStart.current = {
      x: e.clientX,
      y: e.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;

    if (!start) {
      return;
    }

    setOffset(
      clampOffset(
        {
          x: start.ox + (e.clientX - start.x),
          y: start.oy + (e.clientY - start.y),
        },
        zoom,
      ),
    );
  };

  const handlePointerUp = () => {
    dragStart.current = undefined;
  };

  const handleZoom = (value: number) => {
    setZoom(value);
    setOffset(o => clampOffset(o, value));
  };

  const handleSave = () => {
    if (!size) {
      return;
    }

    setSaving(true);

    // The viewport center maps to this source-image point; the visible
    // square is VIEWPORT / displayScale source pixels wide.
    const visible = VIEWPORT / displayScale;
    const centerX = size.w / 2 - offset.x / displayScale;
    const centerY = size.h / 2 - offset.y / displayScale;

    resizeImageFile(file, {
      maxSize: OUTPUT_SIZE,
      sourceRect: {
        x: centerX - visible / 2,
        y: centerY - visible / 2,
        width: visible,
        height: visible,
      },
    })
      .then(cropped => {
        onCropped(cropped);
        closeDialog(true);
      })
      .catch((e: Error) => errorHandler(e))
      .finally(() => setSaving(false));
  };

  return (
    <Dialog {...dialogProps}>
      {show && (
        <>
          <DialogTitle>
            <h1>Adjust image</h1>
          </DialogTitle>
          <DialogContent>
            <Column>
              <Viewport
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
              >
                {url && (
                  <CropImage
                    src={url}
                    alt=''
                    draggable={false}
                    onLoad={e =>
                      setSize({
                        w: e.currentTarget.naturalWidth,
                        h: e.currentTarget.naturalHeight,
                      })
                    }
                    onError={() => {
                      errorHandler(
                        new Error(
                          `Could not display "${file.name}" — it may not be a supported image format`,
                        ),
                      );
                      closeDialog(false);
                    }}
                    style={
                      size
                        ? {
                            width: size.w * displayScale,
                            height: size.h * displayScale,
                            transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                          }
                        : undefined
                    }
                  />
                )}
                <MaskRing aria-hidden $circle={!!circle} />
              </Viewport>
              <Row center gap='1ch'>
                <ZoomSlider
                  type='range'
                  aria-label='Zoom'
                  min={1}
                  max={4}
                  step={0.01}
                  value={zoom}
                  onChange={e => handleZoom(Number(e.target.value))}
                />
              </Row>
            </Column>
          </DialogContent>
          <DialogActions>
            <Button subtle onClick={() => closeDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !size}>
              Save
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

const Viewport = styled.div`
  position: relative;
  width: ${VIEWPORT}px;
  height: ${VIEWPORT}px;
  margin-inline: auto;
  overflow: hidden;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  cursor: grab;
  touch-action: none;

  &:active {
    cursor: grabbing;
  }
`;

const CropImage = styled.img`
  position: absolute;
  top: 50%;
  left: 50%;
  max-width: none;
  user-select: none;
  pointer-events: none;
`;

/** Darkens everything outside the avatar area. */
const MaskRing = styled.div<{ $circle: boolean }>`
  position: absolute;
  inset: 0;
  border-radius: ${p => (p.$circle ? '50%' : '20%')};
  box-shadow: 0 0 0 ${VIEWPORT}px rgba(0, 0, 0, 0.45);
  pointer-events: none;
`;

const ZoomSlider = styled.input`
  flex: 1;
  accent-color: ${p => p.theme.colors.main};
`;
