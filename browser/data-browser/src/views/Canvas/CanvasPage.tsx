import { EditableTitle } from '@components/EditableTitle';
import { useDarkMode } from '@helpers/useDarkMode';
import {
  canvas,
  DEFAULT_STROKE_WIDTH,
  enableLoro,
  parseCanvasStrokes,
  ResourceEvents,
  strokeToJson,
  type CanvasStroke,
  type Resource,
  type Version,
} from '@tomic/lib';
import type { ResourcePageProps } from '@views/ResourcePage';
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { drawCanvasStrokes, screenToCanvas } from './canvas-draw';
import { FaRotateLeft, FaRotateRight } from 'react-icons/fa6';

/**
 * Pixels of horizontal pointer travel that map to scrubbing through the
 * entire Loro history. Matches the Flutter undo-button drag gesture
 * (`canvas/infinite_canvas.dart:_onUndoPanDelta`).
 */
const SCRUB_PIXELS_PER_HISTORY = 300;

/**
 * Threshold (px) before a pointer-down on the undo button is treated as a
 * drag instead of a tap. Below the threshold the gesture falls back to
 * single-step `resource.undo()`.
 */
const SCRUB_DRAG_THRESHOLD = 5;

type ScrubState = {
  pointerId: number;
  startX: number;
  versions: Version[];
  /** index the scrub started at — always `versions.length - 1` (current) */
  startIndex: number;
  /** most recent index resolved during the gesture */
  currentIndex: number;
  dragged: boolean;
};

const PEN_COLORS = [
  0xff000000, 0xffe63946, 0xfff4a261, 0xff2a9d8f, 0xff457b9d, 0xff9b5de5,
];

export const CanvasPage: React.FC<ResourcePageProps> = ({ resource }) => {
  const [darkMode] = useDarkMode();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [strokes, setStrokes] = useState<CanvasStroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<CanvasStroke | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [penWidth, setPenWidth] = useState(DEFAULT_STROKE_WIDTH);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // History scrub state — populated while the user holds + drags the undo
  // button. While non-null the canvas paints `previewStrokes` (a historical
  // version) instead of the live `strokes`, matching Flutter's drag-to-scrub
  // gesture.
  const [previewStrokes, setPreviewStrokes] = useState<CanvasStroke[] | null>(
    null,
  );
  const scrubRef = useRef<ScrubState | null>(null);

  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  const strokesRef = useRef(strokes);
  const currentStrokeRef = useRef(currentStroke);
  const previewStrokesRef = useRef(previewStrokes);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  const drawingPointerRef = useRef<number | null>(null);
  const isPanModeRef = useRef(false);
  const [panMode, setPanMode] = useState<'idle' | 'ready' | 'panning'>('idle');

  // Track Space key for pan mode
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        isPanModeRef.current = true;
        setPanMode('ready');
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isPanModeRef.current = false;
        setPanMode(p => (p === 'panning' ? 'idle' : 'idle'));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  scaleRef.current = scale;
  offsetRef.current = offset;
  strokesRef.current = strokes;
  currentStrokeRef.current = currentStroke;
  previewStrokesRef.current = previewStrokes;

  const reloadStrokesFromResource = useCallback((res: Resource) => {
    setStrokes(parseCanvasStrokes(res.get(canvas.properties.strokeData)));
  }, []);

  useEffect(() => {
    reloadStrokesFromResource(resource);
    resource.ensureUndoManager();
    setCanUndo(resource.canUndo());
    setCanRedo(resource.canRedo());

    const unsub = resource.on(ResourceEvents.LocalChange, prop => {
      if (
        prop === canvas.properties.strokeData ||
        prop === '' ||
        prop === undefined
      ) {
        reloadStrokesFromResource(resource);
      }
    });

    return unsub;
  }, [resource, reloadStrokesFromResource]);

  const paint = useCallback(() => {
    const el = canvasRef.current;
    const container = containerRef.current;

    if (!el || !container) {
      return;
    }

    const ctx = el.getContext('2d');

    if (!ctx) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const w = container.clientWidth;
    const h = container.clientHeight;

    if (el.width !== w * dpr || el.height !== h * dpr) {
      el.width = w * dpr;
      el.height = h * dpr;
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    ctx.clearRect(0, 0, w, h);
    drawCanvasStrokes(
      ctx,
      // Show the scrub preview while the user is dragging the undo button;
      // otherwise the live strokes. The current in-progress stroke is
      // hidden during scrub (we're showing a historical state).
      previewStrokesRef.current ?? strokesRef.current,
      previewStrokesRef.current ? null : currentStrokeRef.current,
      scaleRef.current,
      offsetRef.current.x,
      offsetRef.current.y,
      darkMode,
    );
  }, [darkMode]);

  useEffect(() => {
    paint();
  }, [paint, strokes, currentStroke, scale, offset, previewStrokes]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const ro = new ResizeObserver(() => paint());
    ro.observe(container);
    return () => ro.disconnect();
  }, [paint]);

  const handleUndo = useCallback(async () => {
    if (!resource.undo()) return;
    setCanUndo(resource.canUndo());
    setCanRedo(resource.canRedo());
    setSaving(true);
    try {
      await resource.save();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [resource]);

  const handleRedo = useCallback(async () => {
    if (!resource.redo()) return;
    setCanUndo(resource.canUndo());
    setCanRedo(resource.canRedo());
    setSaving(true);
    try {
      await resource.save();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [resource]);

  // ───────────────── History-scrub gesture (Flutter parity) ────────────────
  //
  // Press the undo button and drag horizontally: each `SCRUB_PIXELS_PER_HISTORY`
  // of horizontal travel scrubs through the entire Loro history of stroke
  // edits. Release to commit to the scrubbed-to version (one atomic
  // `replaceListItems` → one undo checkpoint). A plain press-and-release
  // (no drag past `SCRUB_DRAG_THRESHOLD`) falls back to single-step undo.
  //
  // The pointer is captured on down, so the gesture survives the cursor
  // leaving the button. Preview repaints happen via `previewStrokes` state,
  // so the canvas re-renders without touching the live Loro doc.

  const onUndoPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!canUndo) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      const versions = resource.getLoroHistory();
      scrubRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        versions,
        startIndex: versions.length - 1,
        currentIndex: versions.length - 1,
        dragged: false,
      };
    },
    [canUndo, resource],
  );

  const onUndoPointerMove = useCallback((e: React.PointerEvent) => {
    const s = scrubRef.current;
    if (!s || s.pointerId !== e.pointerId) return;

    const dx = e.clientX - s.startX;
    if (!s.dragged && Math.abs(dx) < SCRUB_DRAG_THRESHOLD) return;
    s.dragged = true;

    const total = s.versions.length;
    if (total === 0) return;

    // Map raw dx to a history index. Drag-left (negative dx) scrubs
    // backward through history; drag-right scrubs forward.
    const stepsBack = Math.round((-dx / SCRUB_PIXELS_PER_HISTORY) * total);
    const idx = Math.max(0, Math.min(total - 1, s.startIndex - stepsBack));
    if (idx === s.currentIndex) return;
    s.currentIndex = idx;

    const propvals = s.versions[idx]?.propvals;
    const raw = propvals?.get(canvas.properties.strokeData);
    setPreviewStrokes(parseCanvasStrokes(raw));
  }, []);

  const onUndoPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      const s = scrubRef.current;
      if (!s || s.pointerId !== e.pointerId) return;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      scrubRef.current = null;

      // No real drag → treat as a tap = single-step undo.
      if (!s.dragged) {
        await handleUndo();
        return;
      }

      // Real drag → commit the scrubbed-to version. Clear the preview
      // overlay first so the canvas reverts to live strokes while the
      // save round-trips; then `replaceListItems` updates them in place.
      setPreviewStrokes(null);

      // Released back where we started? Nothing to commit.
      if (s.currentIndex === s.startIndex) {
        return;
      }

      const target = s.versions[s.currentIndex];
      const historicalStrokes = parseCanvasStrokes(
        target?.propvals.get(canvas.properties.strokeData),
      );
      const itemsForLoro = historicalStrokes.map(strokeToJson);

      setSaving(true);
      setSaveError(undefined);

      try {
        await enableLoro();
        resource.replaceListItems(canvas.properties.strokeData, itemsForLoro);
        await resource.save();
      } catch (err) {
        setSaveError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }

      setCanUndo(resource.canUndo());
      setCanRedo(resource.canRedo());
    },
    [handleUndo, resource],
  );

  const onUndoPointerCancel = useCallback((e: React.PointerEvent) => {
    const s = scrubRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    scrubRef.current = null;
    // Pointer cancelled mid-scrub (system gesture, focus loss). Drop the
    // preview; the live strokes are unchanged.
    setPreviewStrokes(null);
  }, []);

  const pushStrokeToServer = async (stroke: CanvasStroke) => {
    setSaving(true);
    setSaveError(undefined);

    try {
      await enableLoro();
      resource.pushListItem(canvas.properties.strokeData, strokeToJson(stroke));
      await resource.save();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }

    setCanUndo(resource.canUndo());
    setCanRedo(resource.canRedo());
  };

  // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z redo
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        if (e.shiftKey) {
          e.preventDefault();
          handleRedo();
        } else {
          e.preventDefault();
          handleUndo();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleUndo, handleRedo]);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = canvasRef.current;

    if (!el) {
      return;
    }

    if (e.button === 1 || (e.button === 0 && isPanModeRef.current)) {
      isPanningRef.current = true;
      setPanMode('panning');
      panStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        ox: offsetRef.current.x,
        oy: offsetRef.current.y,
      };
      el.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) {
      return;
    }

    const rect = el.getBoundingClientRect();
    const [x, y] = screenToCanvas(
      e.clientX,
      e.clientY,
      rect,
      scaleRef.current,
      offsetRef.current.x,
      offsetRef.current.y,
    );

    drawingPointerRef.current = e.pointerId;
    setCurrentStroke({
      color: penColor,
      width: penWidth,
      path: [[x, y]],
    });
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (isPanningRef.current && panStartRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setOffset({
        x: panStartRef.current.ox + dx,
        y: panStartRef.current.oy + dy,
      });
      return;
    }

    if (
      drawingPointerRef.current !== e.pointerId ||
      !currentStrokeRef.current
    ) {
      return;
    }

    const el = canvasRef.current;

    if (!el) {
      return;
    }

    const rect = el.getBoundingClientRect();
    const [x, y] = screenToCanvas(
      e.clientX,
      e.clientY,
      rect,
      scaleRef.current,
      offsetRef.current.x,
      offsetRef.current.y,
    );

    const stroke = currentStrokeRef.current;
    const last = stroke.path[stroke.path.length - 1];
    const minDist = 2 / scaleRef.current;

    if (Math.hypot(x - last[0], y - last[1]) > minDist) {
      setCurrentStroke({
        ...stroke,
        path: [...stroke.path, [x, y]],
      });
    }
  };

  const finishStroke = (e: React.PointerEvent) => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      setPanMode(isPanModeRef.current ? 'ready' : 'idle');
      canvasRef.current?.releasePointerCapture(e.pointerId);
      return;
    }

    if (drawingPointerRef.current !== e.pointerId) {
      return;
    }

    drawingPointerRef.current = null;
    canvasRef.current?.releasePointerCapture(e.pointerId);

    const stroke = currentStrokeRef.current;

    if (!stroke || stroke.path.length === 0) {
      setCurrentStroke(null);
      return;
    }

    setStrokes(prev => [...prev, stroke]);
    setCurrentStroke(null);
    void pushStrokeToServer(stroke);
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const el = canvasRef.current;

    if (!el) {
      return;
    }

    const rect = el.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const nextScale = Math.min(30, Math.max(0.05, scaleRef.current * factor));
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (mx - offsetRef.current.x) / scaleRef.current;
    const worldY = (my - offsetRef.current.y) / scaleRef.current;

    setScale(nextScale);
    setOffset({
      x: mx - worldX * nextScale,
      y: my - worldY * nextScale,
    });
  };

  return (
    <Page>
      <Header>
        <EditableTitle resource={resource} />
        <Toolbar>
          <ColorRow>
            {PEN_COLORS.map(c => (
              <ColorSwatch
                key={c}
                type='button'
                $active={penColor === c}
                $color={c}
                onClick={() => setPenColor(c)}
                aria-label='Pen color'
              />
            ))}
          </ColorRow>
          <label>
            Width
            <input
              type='range'
              min={1}
              max={40}
              value={penWidth}
              onChange={ev => setPenWidth(Number(ev.target.value))}
            />
          </label>
          <UndoButton
            type='button'
            title='Undo (Ctrl+Z) — drag horizontally to scrub history'
            onPointerDown={onUndoPointerDown}
            onPointerMove={onUndoPointerMove}
            onPointerUp={onUndoPointerUp}
            onPointerCancel={onUndoPointerCancel}
            disabled={!canUndo}
            aria-pressed={previewStrokes !== null}
          >
            <FaRotateLeft />
          </UndoButton>
          <UndoButton
            type='button'
            title='Redo (Ctrl+Shift+Z)'
            onClick={handleRedo}
            disabled={!canRedo}
          >
            <FaRotateRight />
          </UndoButton>
          {saving && <Status>Saving…</Status>}
          {saveError && <Status $error>{saveError}</Status>}
        </Toolbar>
      </Header>
      <CanvasArea
        ref={containerRef}
        onWheel={onWheel}
        $dark={darkMode}
        $panMode={panMode}
      >
        <DrawCanvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
        <Hint>
          Draw with left click · Pan with Space+drag or middle mouse · Scroll to
          zoom · Drag the undo button to scrub history
        </Hint>
      </CanvasArea>
    </Page>
  );
};

const Page = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: ${p => p.theme.heights.fullPage};
  background: ${p => p.theme.colors.bg};
`;

const Header = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: ${p => p.theme.size()};
  padding: ${p => p.theme.size()} ${p => p.theme.size(2)};
  border-bottom: 1px solid ${p => p.theme.colors.bg2};
`;

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: ${p => p.theme.size(2)};
  margin-left: auto;

  label {
    display: flex;
    align-items: center;
    gap: ${p => p.theme.size()};
    font-size: 0.875rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const ColorRow = styled.div`
  display: flex;
  gap: 4px;
`;

const ColorSwatch = styled.button<{ $color: number; $active: boolean }>`
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 2px solid
    ${p => (p.$active ? p.theme.colors.text : p.theme.colors.bg2)};
  background: #${p => (p.$color >>> 0).toString(16).padStart(8, '0').slice(2)};
  cursor: pointer;
  padding: 0;
`;

const UndoButton = styled.button<{ disabled: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background: transparent;
  color: ${p => (p.disabled ? p.theme.colors.textLight : p.theme.colors.text)};
  cursor: ${p => (p.disabled ? 'default' : 'pointer')};
  opacity: ${p => (p.disabled ? 0.4 : 1)};
  font-size: 0.875rem;
  padding: 0;

  &:hover:not(:disabled) {
    background: ${p => p.theme.colors.bg1};
  }
`;

const Status = styled.span<{ $error?: boolean }>`
  font-size: 0.875rem;
  color: ${p => (p.$error ? p.theme.colors.alert : p.theme.colors.textLight)};
`;

const CanvasArea = styled.div<{ $dark: boolean; $panMode: string }>`
  position: relative;
  flex: 1;
  min-height: 400px;
  overflow: hidden;
  touch-action: none;
  background: ${p => (p.$dark ? '#1a1a1a' : '#f5f5f0')};
  cursor: ${p =>
    p.$panMode === 'ready'
      ? 'grab'
      : p.$panMode === 'panning'
        ? 'grabbing'
        : 'crosshair'};
`;

const DrawCanvas = styled.canvas`
  display: block;
  width: 100%;
  height: 100%;
`;

const Hint = styled.p`
  position: absolute;
  bottom: ${p => p.theme.size()};
  left: ${p => p.theme.size(2)};
  margin: 0;
  font-size: 0.75rem;
  color: ${p => p.theme.colors.textLight};
  pointer-events: none;
  opacity: 0.8;
`;
