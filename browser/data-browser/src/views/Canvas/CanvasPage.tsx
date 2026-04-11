import { useDarkMode } from '@helpers/useDarkMode';
import {
  canvas,
  core,
  DEFAULT_STROKE_WIDTH,
  enableLoro,
  parseCanvasStrokes,
  ResourceEvents,
  strokeToJson,
  type CanvasStroke,
  type Resource,
  type Version,
} from '@tomic/lib';
import { useStore } from '@tomic/react';
import type { ResourcePageProps } from '@views/ResourcePage';
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { drawCanvasStrokes, screenToCanvas } from './canvas-draw';
import {
  FaCircleInfo,
  FaEraser,
  FaExpand,
  FaPen,
  FaPlus,
  FaRotateLeft,
  FaRotateRight,
} from 'react-icons/fa6';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { FanOverlay } from './FanOverlay';
import {
  hoveredColor as resolveHoveredColor,
  hoveredWidth as resolveHoveredWidth,
} from './fan-helpers';
import { currentWheelSessionStartedAt } from '@helpers/wheelSession';

/**
 * Pixels of horizontal pointer travel that map to scrubbing through the
 * entire Loro history. Matches Flutter's `_onUndoPanDelta`.
 */
const SCRUB_PIXELS_PER_HISTORY = 300;
const SCRUB_DRAG_THRESHOLD = 5;

/**
 * Pixels of horizontal drag on the zoom button that double (or halve) the
 * canvas scale. Matches Flutter's `_onZoomScrubDelta` ratio.
 */
const ZOOM_SCRUB_PX_PER_2X = 150;

/**
 * Maximum number of undo / redo snapshots retained per canvas. Each entry
 * is a JSON-serialised stroke list (a `CanvasStroke[]`), so the cap also
 * bounds `localStorage` use.
 */
const UNDO_STACK_LIMIT = 200;

type UndoState = { undo: CanvasStroke[][]; redo: CanvasStroke[][] };

const undoStorageKey = (subject: string) => `canvas-undo:${subject}`;

function loadUndoState(subject: string): UndoState {
  try {
    const raw = localStorage.getItem(undoStorageKey(subject));
    if (!raw) return { undo: [], redo: [] };
    const parsed = JSON.parse(raw) as UndoState;

    return {
      undo: Array.isArray(parsed.undo) ? parsed.undo : [],
      redo: Array.isArray(parsed.redo) ? parsed.redo : [],
    };
  } catch {
    return { undo: [], redo: [] };
  }
}

function saveUndoState(subject: string, state: UndoState): void {
  try {
    localStorage.setItem(undoStorageKey(subject), JSON.stringify(state));
  } catch {
    // Disabled / quota exceeded — undo simply doesn't persist this session.
  }
}

/** Shallow clone of a stroke list — paths copied so future mutations of
 *  the live array don't bleed into the snapshot. */
function cloneStrokes(strokes: CanvasStroke[]): CanvasStroke[] {
  return strokes.map(s => ({
    color: s.color,
    width: s.width,
    path: s.path.map(p => [p[0], p[1]] as [number, number]),
  }));
}

/**
 * Pen-color swatches and stroke widths — match Flutter `fan_helpers.dart` so
 * a canvas drawn on one device renders identically on the other. Stored as
 * 0xAARRGGBB ints so the wire format also matches Flutter's `StrokeData`.
 */
const PEN_COLORS = [
  0xff000000, 0xffe63946, 0xfff4a261, 0xff2a9d8f, 0xff457b9d, 0xff9b5de5,
];
const PEN_WIDTHS = [1, 2, 5, 10, 18, 30, 46];

/**
 * Eraser hit-radius in screen pixels — multiplied by `1 / scale` at the
 * call site so the visual radius is constant regardless of zoom.
 */
const ERASE_SCREEN_RADIUS = 15;

const PARENT_PROP = 'https://atomicdata.dev/properties/parent';

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

export const CanvasPage: React.FC<ResourcePageProps> = ({ resource }) => {
  const [darkMode] = useDarkMode();
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [strokes, setStrokes] = useState<CanvasStroke[]>([]);
  const [currentStroke, setCurrentStroke] = useState<CanvasStroke | null>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [penColor, setPenColor] = useState(PEN_COLORS[0]);
  const [prevColor, setPrevColor] = useState(PEN_COLORS[1]);
  const [penWidth, setPenWidth] = useState(DEFAULT_STROKE_WIDTH);
  const [prevWidth, setPrevWidth] = useState(3);
  const [eraserMode, setEraserMode] = useState(false);

  // Wheel events (pan AND zoom) are ignored if the current wheel session
  // started before the canvas was mounted — that's how we detect macOS
  // momentum-scroll tails carried over from the previous view. See
  // `helpers/wheelSession.ts`. Reset on resource change (= canvas-to-canvas
  // navigation) so each canvas starts gated.
  const canvasMountedAtRef = useRef(performance.now());

  // Custom cursor preview: a circle the size of the next stroke at the
  // current zoom (`penWidth × scale`). Null while not hovering, or while
  // drawing / erasing / panning (those have their own visual feedback).
  // Position is relative to the canvas container.
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(
    null,
  );

  // Persistent undo / redo stacks (per-canvas, localStorage-backed).
  // Loro's `UndoManager` is session-scoped — once the page reloads it
  // starts empty and the undo button greys out even with prior strokes
  // present. Instead, store snapshots of `strokeData` before each user
  // edit and persist them. On mount we either load from `localStorage` or
  // bootstrap from `getLoroHistory()` so a canvas you've never opened on
  // this device still has its full pre-existing history available.
  const undoStackRef = useRef<CanvasStroke[][]>([]);
  const redoStackRef = useRef<CanvasStroke[][]>([]);

  // Fan state — populated while the user holds + drags the colour or
  // width button. `fanType` null means no fan is open. The overlay reads
  // these refs through React state to render previews.
  const [fanType, setFanType] = useState<'color' | 'width' | null>(null);
  const [fanButtonCenter, setFanButtonCenter] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [fanDragOffset, setFanDragOffset] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [fanHoveredColor, setFanHoveredColor] = useState<number | null>(null);
  const [fanHoveredWidth, setFanHoveredWidth] = useState<number | null>(null);
  const [fanPeek, setFanPeek] = useState(false);
  // Pointer-ID owning the open fan gesture, plus whether the drag has
  // crossed the tap-vs-drag threshold.
  const fanGestureRef = useRef<{
    pointerId: number;
    type: 'color' | 'width';
    buttonCenter: { x: number; y: number };
    dragged: boolean;
  } | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>();
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // History scrub preview — when set, the canvas paints these instead of the
  // live `strokes`. Matches Flutter's drag-to-scrub gesture on the undo
  // button.
  const [previewStrokes, setPreviewStrokes] = useState<CanvasStroke[] | null>(
    null,
  );
  const scrubRef = useRef<ScrubState | null>(null);

  // Eraser drag state: indices of strokes the current drag has marked for
  // deletion. Materialized as one atomic `replaceListItems` on release so the
  // UndoManager records the whole erase as one undo step.
  const erasedIndicesRef = useRef<Set<number>>(new Set());

  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  const strokesRef = useRef(strokes);
  const currentStrokeRef = useRef(currentStroke);
  const previewStrokesRef = useRef(previewStrokes);
  const eraserModeRef = useRef(eraserMode);
  const isPanningRef = useRef(false);
  const panStartRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  const drawingPointerRef = useRef<number | null>(null);
  const erasingPointerRef = useRef<number | null>(null);
  const isPanModeRef = useRef(false);
  const [panMode, setPanMode] = useState<'idle' | 'ready' | 'panning'>('idle');

  // Track Space key for pan mode (Space+drag = pan, matching Figma/Photoshop).
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
  eraserModeRef.current = eraserMode;

  const reloadStrokesFromResource = useCallback((res: Resource) => {
    setStrokes(parseCanvasStrokes(res.get(canvas.properties.strokeData)));
  }, []);

  /** Persist the current undo / redo stacks under the canvas subject. */
  const persistUndoState = useCallback(() => {
    saveUndoState(resource.subject, {
      undo: undoStackRef.current,
      redo: redoStackRef.current,
    });
  }, [resource.subject]);

  useEffect(() => {
    // Reset the wheel-session gate baseline on mount and on canvas-to-
    // canvas navigation, so we can detect "this wheel session began
    // before this canvas was visible".
    canvasMountedAtRef.current = performance.now();

    reloadStrokesFromResource(resource);

    // Load (or bootstrap) the persistent undo state for THIS canvas. The
    // bootstrap walks `getLoroHistory()` — every prior version except the
    // latest becomes an undo step, so a freshly-loaded canvas with N
    // historical commits exposes N-1 undo steps immediately.
    const stored = loadUndoState(resource.subject);

    if (stored.undo.length === 0 && stored.redo.length === 0) {
      const versions = resource.getLoroHistory();
      const reconstructed: CanvasStroke[][] = [];

      for (let i = 0; i < versions.length - 1; i++) {
        reconstructed.push(
          parseCanvasStrokes(
            versions[i].propvals.get(canvas.properties.strokeData),
          ),
        );
      }

      undoStackRef.current = reconstructed.slice(-UNDO_STACK_LIMIT);
      redoStackRef.current = [];
    } else {
      undoStackRef.current = stored.undo;
      redoStackRef.current = stored.redo;
    }

    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);

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

  // ──────────────── Undo / Redo / scrub-history (Flutter parity) ───────────
  //
  // Tap = `resource.undo()`, drag = scrub through `getLoroHistory()` with
  // live preview, release = `replaceListItems` to the scrubbed-to version
  // (one undo checkpoint). See `planning/canvas-undo-consolidation.md` for
  // the design.

  /** Snapshot the current strokes onto the undo stack. Called before every
   *  user-visible edit (push stroke, erase). Truncates the redo stack
   *  since the user is on a new forward branch. */
  const pushUndoSnapshot = useCallback(
    (preEditStrokes: CanvasStroke[]) => {
      undoStackRef.current.push(cloneStrokes(preEditStrokes));

      if (undoStackRef.current.length > UNDO_STACK_LIMIT) {
        undoStackRef.current.shift();
      }

      redoStackRef.current = [];
      persistUndoState();
      setCanUndo(true);
      setCanRedo(false);
    },
    [persistUndoState],
  );

  const applyHistoricalStrokes = useCallback(
    async (target: CanvasStroke[]) => {
      setSaving(true);
      setSaveError(undefined);

      try {
        await enableLoro();
        resource.replaceListItems(
          canvas.properties.strokeData,
          target.map(strokeToJson),
        );
        await resource.save();
      } catch (e) {
        setSaveError(e instanceof Error ? e.message : String(e));
      } finally {
        setSaving(false);
      }
    },
    [resource],
  );

  const handleUndo = useCallback(async () => {
    if (undoStackRef.current.length === 0) return;

    const target = undoStackRef.current.pop()!;
    redoStackRef.current.push(cloneStrokes(strokesRef.current));

    if (redoStackRef.current.length > UNDO_STACK_LIMIT) {
      redoStackRef.current.shift();
    }

    persistUndoState();
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);

    await applyHistoricalStrokes(target);
  }, [applyHistoricalStrokes, persistUndoState]);

  const handleRedo = useCallback(async () => {
    if (redoStackRef.current.length === 0) return;

    const target = redoStackRef.current.pop()!;
    undoStackRef.current.push(cloneStrokes(strokesRef.current));

    if (undoStackRef.current.length > UNDO_STACK_LIMIT) {
      undoStackRef.current.shift();
    }

    persistUndoState();
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);

    await applyHistoricalStrokes(target);
  }, [applyHistoricalStrokes, persistUndoState]);

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

      // No drag → tap = single-step undo.
      if (!s.dragged) {
        await handleUndo();
        return;
      }

      setPreviewStrokes(null);

      if (s.currentIndex === s.startIndex) {
        return;
      }

      const target = s.versions[s.currentIndex];
      const historicalStrokes = parseCanvasStrokes(
        target?.propvals.get(canvas.properties.strokeData),
      );

      // Scrub-release commits a historical state — record the pre-scrub
      // strokes as an undoable step so a plain undo press unwinds it.
      pushUndoSnapshot(strokesRef.current);

      await applyHistoricalStrokes(historicalStrokes);
    },
    [applyHistoricalStrokes, handleUndo, pushUndoSnapshot],
  );

  const onUndoPointerCancel = useCallback((e: React.PointerEvent) => {
    const s = scrubRef.current;
    if (!s || s.pointerId !== e.pointerId) return;
    scrubRef.current = null;
    setPreviewStrokes(null);
  }, []);

  // ──────────────── Save / draw the actual stroke ──────────────────────────

  const pushStrokeToServer = async (
    stroke: CanvasStroke,
    preEditStrokes: CanvasStroke[],
  ) => {
    pushUndoSnapshot(preEditStrokes);
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
  };

  // ──────────────── Eraser: drag across strokes deletes them ───────────────
  //
  // Identical hit-test to Flutter's `_eraseAt`: per stroke, any point within
  // `(15 + width/2)` screen pixels of the cursor marks the stroke. All
  // marked strokes flush as one atomic `replaceListItems` on release so the
  // UndoManager records the erase as a single undo step.

  const eraseAt = useCallback((canvasX: number, canvasY: number) => {
    const hitRadius = ERASE_SCREEN_RADIUS / scaleRef.current;
    const erased = erasedIndicesRef.current;
    const strokesNow = strokesRef.current;
    let changed = false;

    for (let i = 0; i < strokesNow.length; i++) {
      if (erased.has(i)) continue;
      const stroke = strokesNow[i];
      const radius = hitRadius + stroke.width / 2 / scaleRef.current;
      for (const [px, py] of stroke.path) {
        if (Math.hypot(canvasX - px, canvasY - py) < radius) {
          erased.add(i);
          changed = true;
          break;
        }
      }
    }

    if (changed) {
      // Optimistic visual: paint the canvas without the erased strokes.
      // We DON'T mutate the resource until pointer-up; this is preview
      // only. Reusing `previewStrokes` keeps `paint()` consistent.
      const preview = strokesNow.filter((_, i) => !erased.has(i));
      setPreviewStrokes(preview);
    }
  }, []);

  const finishErase = useCallback(async () => {
    if (erasedIndicesRef.current.size === 0) {
      setPreviewStrokes(null);

      return;
    }

    const preEdit = strokesRef.current;
    const remaining = preEdit.filter(
      (_, i) => !erasedIndicesRef.current.has(i),
    );
    erasedIndicesRef.current = new Set();
    setPreviewStrokes(null);

    pushUndoSnapshot(preEdit);

    setSaving(true);
    setSaveError(undefined);

    try {
      await enableLoro();
      resource.replaceListItems(
        canvas.properties.strokeData,
        remaining.map(strokeToJson),
      );
      await resource.save();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [pushUndoSnapshot, resource]);

  // ──────────────── Pointer flow: pan / draw / erase ───────────────────────

  /**
   * Update / clear the cursor preview. Called from both pointerenter and
   * pointermove so the preview appears the moment the cursor enters the
   * canvas, not only after the first move.
   */
  const trackCursorForPreview = useCallback((e: React.PointerEvent) => {
    if (
      isPanningRef.current ||
      drawingPointerRef.current !== null ||
      erasingPointerRef.current !== null ||
      eraserModeRef.current
    ) {
      setCursorPos(null);

      return;
    }

    const container = containerRef.current;

    if (!container) return;

    const rect = container.getBoundingClientRect();
    setCursorPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    // Drawing / erasing starts — hide the hover preview; the stroke itself
    // is the feedback.
    setCursorPos(null);

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

    if (eraserModeRef.current) {
      erasingPointerRef.current = e.pointerId;
      el.setPointerCapture(e.pointerId);
      eraseAt(x, y);

      return;
    }

    drawingPointerRef.current = e.pointerId;
    setCurrentStroke({
      color: penColor,
      width: penWidth,
      path: [[x, y]],
    });
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    trackCursorForPreview(e);

    if (isPanningRef.current && panStartRef.current) {
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      setOffset({
        x: panStartRef.current.ox + dx,
        y: panStartRef.current.oy + dy,
      });

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

    if (erasingPointerRef.current === e.pointerId) {
      eraseAt(x, y);

      return;
    }

    if (
      drawingPointerRef.current !== e.pointerId ||
      !currentStrokeRef.current
    ) {
      return;
    }

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

    if (erasingPointerRef.current === e.pointerId) {
      erasingPointerRef.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      void finishErase();

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

    // Snapshot pre-edit strokes BEFORE adding the new one — the undo
    // target should restore to *before* this stroke.
    const preEditStrokes = strokesRef.current;
    setStrokes(prev => [...prev, stroke]);
    setCurrentStroke(null);
    void pushStrokeToServer(stroke, preEditStrokes);
  };

  // Wheel handling: attached natively with `{ passive: false }` so we can
  // actually `preventDefault()`. React's synthetic `onWheel` is passive by
  // default and silently drops `preventDefault()` calls, which means
  // Ctrl-/Cmd-wheel and trackpad pinch end up zooming the whole browser
  // page instead of just the canvas.
  useEffect(() => {
    const container = containerRef.current;

    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      // Suppress the browser's default for every wheel inside the canvas:
      // plain wheel would scroll the page, Ctrl/Cmd-wheel and trackpad
      // pinch would zoom the whole browser UI.
      e.preventDefault();

      const el = canvasRef.current;

      if (!el) return;

      // Ignore wheel events that belong to a scroll session that *started*
      // before this canvas became visible. That session is a macOS
      // momentum-scroll tail carried over from the previous view; the user
      // didn't initiate scrolling here. Once a new wheel session begins
      // (gap > WHEEL_SESSION_GAP_MS, set in `helpers/wheelSession.ts`),
      // its events count normally. See that file for the rationale.
      if (currentWheelSessionStartedAt() < canvasMountedAtRef.current) {
        return;
      }

      // Match Flutter's `_onPointerSignal` (infinite_canvas.dart:747-768):
      //
      // * Plain wheel  → pan the canvas by the scroll delta.
      // * Ctrl / Cmd wheel  → zoom toward the cursor.
      //
      // The Ctrl-modified branch also covers macOS / Windows trackpad pinch,
      // which the browser surfaces as `wheel` events with `ctrlKey === true`.
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();

        // A discrete scrollwheel notch arrives as a single big `deltaY`
        // (typically ±100), so a fixed 10 % step per event is the right
        // feel. A macOS trackpad pinch arrives as a *stream* of small
        // `deltaY` values (often ±2 to ±15); applying that same 10 % step
        // to every event makes the canvas zoom 10×+ per pinch. Switch on
        // magnitude: small deltas → continuous exponential scaling
        // proportional to motion; large deltas → discrete notch.
        const isCoarseNotch = Math.abs(e.deltaY) >= 50;
        const factor = isCoarseNotch
          ? e.deltaY < 0
            ? 1.1
            : 1 / 1.1
          : Math.exp(-e.deltaY * 0.005);
        const nextScale = Math.min(
          30,
          Math.max(0.05, scaleRef.current * factor),
        );
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const worldX = (mx - offsetRef.current.x) / scaleRef.current;
        const worldY = (my - offsetRef.current.y) / scaleRef.current;

        setScale(nextScale);
        setOffset({
          x: mx - worldX * nextScale,
          y: my - worldY * nextScale,
        });

        return;
      }

      // Plain wheel → pan. Negative-delta = subtract from offset so the
      // content scrolls in the natural direction. macOS "natural scrolling"
      // already inverts the sign at the OS layer.
      setOffset({
        x: offsetRef.current.x - e.deltaX,
        y: offsetRef.current.y - e.deltaY,
      });
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => container.removeEventListener('wheel', handleWheel);
  }, []);

  // ──────────────── Toolbar button handlers ────────────────────────────────

  // Keyboard shortcuts: Ctrl+Z undo, Ctrl+Shift+Z redo.
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

  // Help dialog — shows the keyboard / gesture cheat-sheet that used to
  // live in an always-visible footer hint. Triggered by the info button at
  // the start of the bottom toolbar.
  const [helpDialogProps, showHelp, , isHelpOpen] = useDialog();

  /** New canvas: create one in the same parent and navigate to it. */
  const handleNewCanvas = useCallback(async () => {
    const parent = resource.get(PARENT_PROP);

    if (typeof parent !== 'string' || !parent) return;

    setSaving(true);
    setSaveError(undefined);

    try {
      await enableLoro();
      const newCanvas = await store.newResource({
        parent,
        isA: canvas.classes.canvas,
        propVals: {
          [core.properties.name]: 'Canvas',
        },
      });
      await newCanvas.save();
      navigate(constructOpenURL(newCanvas.subject));
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [resource, store, navigate]);

  // ──────────────── Color & Width fans (Flutter parity) ───────────────────
  //
  // Press-and-hold the Color (or Width) button: a fan of swatches sprouts
  // from the button centre (32 colours in 4 rings, 7 widths on a single
  // semicircle). Drag toward a swatch to snap-select it; release to commit
  // (swap prev ↔ current, current ← picked). A plain release without drag
  // = tap = swap prev ↔ current.
  //
  // The button owns the pointer capture; the FanOverlay is render-only.

  const openFanFromButton = useCallback(
    (
      e: React.PointerEvent<HTMLButtonElement>,
      type: 'color' | 'width',
    ): void => {
      e.preventDefault();
      const target = e.currentTarget;
      target.setPointerCapture(e.pointerId);
      const rect = target.getBoundingClientRect();
      const centre = {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
      };
      fanGestureRef.current = {
        pointerId: e.pointerId,
        type,
        buttonCenter: centre,
        dragged: false,
      };
      setFanType(type);
      setFanButtonCenter(centre);
      setFanDragOffset({ x: 0, y: 0 });
      setFanHoveredColor(null);
      setFanHoveredWidth(null);
      setFanPeek(true);
    },
    [],
  );

  const updateFanFromButton = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      const g = fanGestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;

      const dx = e.clientX - g.buttonCenter.x;
      const dy = e.clientY - g.buttonCenter.y;
      const dragLen = Math.hypot(dx, dy);

      if (!g.dragged && dragLen >= SCRUB_DRAG_THRESHOLD) {
        g.dragged = true;
        setFanPeek(false);
      }

      setFanDragOffset({ x: dx, y: dy });
      if (g.type === 'color') {
        const hit = resolveHoveredColor({ x: dx, y: dy });
        setFanHoveredColor(hit?.color ?? null);
      } else {
        setFanHoveredWidth(resolveHoveredWidth({ x: dx, y: dy }));
      }
    },
    [],
  );

  const closeFanFromButton = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      const g = fanGestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);

      const dragged = g.dragged;
      const type = g.type;
      fanGestureRef.current = null;

      // Snapshot hover before clearing state (state setters won't have
      // committed by the time we read).
      const pickedColor = fanHoveredColor;
      const pickedWidth = fanHoveredWidth;

      setFanType(null);
      setFanButtonCenter(null);
      setFanDragOffset({ x: 0, y: 0 });
      setFanHoveredColor(null);
      setFanHoveredWidth(null);
      setFanPeek(false);

      if (!dragged) {
        // Tap → swap prev ↔ current.
        if (type === 'color') {
          setPenColor(prevColor);
          setPrevColor(penColor);
        } else {
          setPenWidth(prevWidth);
          setPrevWidth(penWidth);
        }

        return;
      }

      // Drag-release: if a swatch is hovered, commit it (prev ← current,
      // current ← picked). If the user landed in the dead-zone, the
      // gesture is a no-op — same as Flutter.
      if (type === 'color' && pickedColor !== null) {
        setPrevColor(penColor);
        setPenColor(pickedColor);
      } else if (type === 'width' && pickedWidth !== null) {
        setPrevWidth(penWidth);
        setPenWidth(pickedWidth);
      }
    },
    [
      fanHoveredColor,
      fanHoveredWidth,
      penColor,
      penWidth,
      prevColor,
      prevWidth,
    ],
  );

  const cancelFanFromButton = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>): void => {
      const g = fanGestureRef.current;
      if (!g || g.pointerId !== e.pointerId) return;
      fanGestureRef.current = null;
      setFanType(null);
      setFanButtonCenter(null);
      setFanDragOffset({ x: 0, y: 0 });
      setFanHoveredColor(null);
      setFanHoveredWidth(null);
      setFanPeek(false);
    },
    [],
  );

  const handleEraserToggle = useCallback(() => setEraserMode(m => !m), []);

  // ──────────────── Zoom scrub gesture (Flutter parity) ────────────────────
  //
  // Tap zoom = fit-all. Press-and-drag the zoom button horizontally: scale
  // = startScale × 2^(dx / SCRUB_PIXELS_PER_ZOOM_DOUBLE), with the world
  // point under the viewport centre pinned in place so the user's focus
  // doesn't drift. Matches Flutter's `_onZoomScrubDelta` (150 px = 2×).

  const zoomScrubRef = useRef<{
    pointerId: number;
    startX: number;
    startScale: number;
    centerWorld: { x: number; y: number };
    dragged: boolean;
  } | null>(null);

  const onZoomPointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const container = containerRef.current;
      if (!container) return;
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);

      const containerW = container.clientWidth;
      const containerH = container.clientHeight;
      const centerWorldX =
        (containerW / 2 - offsetRef.current.x) / scaleRef.current;
      const centerWorldY =
        (containerH / 2 - offsetRef.current.y) / scaleRef.current;

      zoomScrubRef.current = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startScale: scaleRef.current,
        centerWorld: { x: centerWorldX, y: centerWorldY },
        dragged: false,
      };
    },
    [],
  );

  const onZoomPointerMove = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const z = zoomScrubRef.current;
      if (!z || z.pointerId !== e.pointerId) return;

      const dx = e.clientX - z.startX;
      if (!z.dragged && Math.abs(dx) < SCRUB_DRAG_THRESHOLD) return;
      z.dragged = true;

      const container = containerRef.current;
      if (!container) return;

      const nextScale = Math.min(
        30,
        Math.max(0.05, z.startScale * Math.pow(2, dx / ZOOM_SCRUB_PX_PER_2X)),
      );
      setScale(nextScale);
      setOffset({
        x: container.clientWidth / 2 - z.centerWorld.x * nextScale,
        y: container.clientHeight / 2 - z.centerWorld.y * nextScale,
      });
    },
    [],
  );

  // `handleZoomToFit` is declared after these handlers and recreates when
  // `strokes` changes; capture the latest through a ref so the tap path
  // doesn't fit against a stale stroke snapshot. Same pattern as the
  // chatroom send-ref bridge in `ChatRoomPage`.
  const handleZoomToFitRef = useRef<() => void>(() => undefined);

  const onZoomPointerUp = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const z = zoomScrubRef.current;
      if (!z || z.pointerId !== e.pointerId) return;
      (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
      zoomScrubRef.current = null;

      if (!z.dragged) {
        handleZoomToFitRef.current();
      }
    },
    [],
  );

  const onZoomPointerCancel = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      const z = zoomScrubRef.current;
      if (!z || z.pointerId !== e.pointerId) return;
      zoomScrubRef.current = null;
    },
    [],
  );

  /** Zoom to fit: compute the bounding box of all strokes, scale to fit
   * with a small padding, center in the viewport. Matches the start-state
   * of Flutter's zoom button when nothing else has zoomed. The latest
   * version is also kept in `handleZoomToFitRef` so `onZoomPointerUp`
   * (declared above) can call it without a stale-closure bug. */
  const handleZoomToFit = useCallback(() => {
    const container = containerRef.current;

    if (!container || strokes.length === 0) {
      // Reset to default view if nothing to fit.
      setScale(1);
      setOffset({ x: 0, y: 0 });

      return;
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const s of strokes) {
      for (const [x, y] of s.path) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (!Number.isFinite(minX)) {
      setScale(1);
      setOffset({ x: 0, y: 0 });

      return;
    }

    const padding = 40;
    const w = container.clientWidth - padding * 2;
    const h = container.clientHeight - padding * 2;
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const nextScale = Math.min(
      30,
      Math.max(0.05, Math.min(w / contentW, h / contentH)),
    );
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    setScale(nextScale);
    setOffset({
      x: container.clientWidth / 2 - cx * nextScale,
      y: container.clientHeight / 2 - cy * nextScale,
    });
  }, [strokes]);

  // Mirror the latest `handleZoomToFit` into the ref so the zoom button's
  // tap path always sees fresh strokes (see `handleZoomToFitRef` above).
  handleZoomToFitRef.current = handleZoomToFit;

  const widthDotPx = Math.max(4, Math.min(22, penWidth * 0.6));

  return (
    <Page>
      {(saving || saveError) && (
        <SaveStatus $error={!!saveError}>
          {saveError ? `Save failed: ${saveError}` : 'Saving…'}
        </SaveStatus>
      )}
      <CanvasArea
        ref={containerRef}
        $dark={darkMode}
        $panMode={panMode}
        $eraser={eraserMode}
        $previewCursor={cursorPos !== null}
      >
        <DrawCanvas
          ref={canvasRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerEnter={trackCursorForPreview}
          onPointerLeave={() => setCursorPos(null)}
          onPointerUp={finishStroke}
          onPointerCancel={finishStroke}
        />
        {cursorPos && (
          <CursorPreview
            style={{
              // Diameter clamped so a hairline stroke is still visible and
              // a huge zoomed-in brush stays on screen. Centred on the
              // pointer via the `translate(-50%, -50%)` in CursorPreview.
              width: Math.max(4, penWidth * scale),
              height: Math.max(4, penWidth * scale),
              transform: `translate(${cursorPos.x}px, ${cursorPos.y}px) translate(-50%, -50%)`,
              background: colorIntToHex(penColor),
            }}
          />
        )}
        <BottomToolbar>
          <CircleButton
            type='button'
            title='Canvas help'
            onClick={showHelp}
            aria-label='Show canvas help'
          >
            <FaCircleInfo />
          </CircleButton>
          <CircleButton
            type='button'
            title='New canvas'
            onClick={handleNewCanvas}
          >
            <FaPlus />
          </CircleButton>
          <CircleButton
            type='button'
            title={eraserMode ? 'Switch to draw' : 'Eraser'}
            $active={eraserMode}
            onClick={handleEraserToggle}
          >
            {eraserMode ? <FaPen /> : <FaEraser />}
          </CircleButton>
          <ColorCircleButton
            type='button'
            title='Pen color (tap to swap with previous, drag to pick from fan)'
            $color={penColor}
            onPointerDown={e => openFanFromButton(e, 'color')}
            onPointerMove={updateFanFromButton}
            onPointerUp={closeFanFromButton}
            onPointerCancel={cancelFanFromButton}
            aria-label='Pen color'
          />
          <WidthCircleButton
            type='button'
            title={`Stroke width: ${penWidth} (tap to swap with previous, drag to pick from fan)`}
            onPointerDown={e => openFanFromButton(e, 'width')}
            onPointerMove={updateFanFromButton}
            onPointerUp={closeFanFromButton}
            onPointerCancel={cancelFanFromButton}
            aria-label='Stroke width'
          >
            <WidthDot $size={widthDotPx} />
          </WidthCircleButton>
          <CircleButton
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
          </CircleButton>
          <CircleButton
            type='button'
            title='Redo (Ctrl+Shift+Z)'
            onClick={handleRedo}
            disabled={!canRedo}
          >
            <FaRotateRight />
          </CircleButton>
          <CircleButton
            type='button'
            title='Zoom to fit (tap) — drag horizontally to zoom-scrub'
            onPointerDown={onZoomPointerDown}
            onPointerMove={onZoomPointerMove}
            onPointerUp={onZoomPointerUp}
            onPointerCancel={onZoomPointerCancel}
          >
            <FaExpand />
          </CircleButton>
        </BottomToolbar>
      </CanvasArea>
      {fanType && fanButtonCenter && (
        <FanOverlay
          type={fanType}
          buttonCenter={fanButtonCenter}
          dragOffset={fanDragOffset}
          hoveredColor={fanHoveredColor}
          hoveredWidth={fanHoveredWidth}
          peek={fanPeek}
          darkMode={darkMode}
        />
      )}
      <Dialog {...helpDialogProps}>
        {isHelpOpen && (
          <>
            <DialogTitle>
              <h1>Canvas controls</h1>
            </DialogTitle>
            <DialogContent>
              <HelpList>
                <li>
                  <kbd>Left click</kbd> &amp; drag — draw a stroke
                </li>
                <li>
                  <kbd>Scroll</kbd> · <kbd>Space</kbd>+drag · middle-mouse drag
                  — pan the canvas
                </li>
                <li>
                  <kbd>Ctrl</kbd>+<kbd>scroll</kbd> · trackpad pinch — zoom
                  toward the cursor
                </li>
                <li>
                  Tap the eraser button, then drag across strokes to remove them
                </li>
                <li>
                  Tap the colour or width button to swap with the previous
                  choice; press &amp; drag to open the picker fan
                </li>
                <li>
                  Tap <kbd>Undo</kbd> / <kbd>Redo</kbd> to step through edits;
                  drag the undo button left/right to scrub the full history
                </li>
                <li>
                  Tap the zoom button to fit all strokes; drag left/right to
                  zoom continuously
                </li>
                <li>
                  <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+
                  <kbd>Shift</kbd>+<kbd>Z</kbd> redo
                </li>
              </HelpList>
            </DialogContent>
          </>
        )}
      </Dialog>
    </Page>
  );
};

// ──────────────── Styles ───────────────────────────────────────────────────

const Page = styled.div`
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: ${p => p.theme.heights.fullPage};
  background: ${p => p.theme.colors.bg};
  position: relative;
`;

const SaveStatus = styled.span<{ $error?: boolean }>`
  position: absolute;
  top: ${p => p.theme.size()};
  right: ${p => p.theme.size(2)};
  z-index: 2;
  font-size: 0.875rem;
  padding: 4px 10px;
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg};
  color: ${p => (p.$error ? p.theme.colors.alert : p.theme.colors.textLight)};
  border: 1px solid
    ${p => (p.$error ? p.theme.colors.alert : p.theme.colors.bg2)};
`;

const CanvasArea = styled.div<{
  $dark: boolean;
  $panMode: string;
  $eraser: boolean;
  $previewCursor: boolean;
}>`
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
        : p.$eraser
          ? 'cell'
          : // Hide the OS cursor only when the in-canvas preview circle is
            // showing — otherwise crosshair stays so the user isn't left
            // with no pointer at all when the cursor is outside the
            // canvas area but `eraser` / `pan` modes are inactive.
            p.$previewCursor
            ? 'none'
            : 'crosshair'};
`;

/**
 * Pen-tip preview that follows the cursor: a circle sized exactly to the
 * stroke that would land if the user pressed and dragged (`penWidth ×
 * scale` in screen pixels) and filled with the current pen colour. The
 * thin outline keeps the preview visible against same-colour patches of
 * canvas. `pointer-events: none` so it never steals the gesture.
 */
const CursorPreview = styled.div`
  position: absolute;
  top: 0;
  left: 0;
  border-radius: 50%;
  pointer-events: none;
  z-index: 2;
  border: 1px solid rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  /* The toolbar pill sits above this (z-index 3) so hovering near the
     bottom of the canvas doesn't paint the preview over a button. */
`;

const DrawCanvas = styled.canvas`
  display: block;
  width: 100%;
  height: 100%;
`;

const HelpList = styled.ul`
  margin: 0;
  padding-left: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  color: ${p => p.theme.colors.text};

  & kbd {
    background: ${p => p.theme.colors.bg1};
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: 4px;
    padding: 0 0.35em;
    font-size: 0.85em;
    font-family: inherit;
  }
`;

/**
 * Bottom pill toolbar — matches Flutter's `bottom_toolbar.dart` desktop
 * layout: floating, centered, rounded, theme-aware background with a soft
 * shadow. Compact widths just shrink the gap; the desktop pill survives.
 */
const BottomToolbar = styled.div`
  position: absolute;
  bottom: ${p => p.theme.size(2)};
  left: 50%;
  transform: translateX(-50%);
  z-index: 3;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  background: ${p => p.theme.colors.bg};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: 32px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18);
`;

interface CircleButtonProps {
  $active?: boolean;
}

const CircleButton = styled.button<CircleButtonProps>`
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: ${p => (p.$active ? p.theme.colors.main : 'transparent')};
  color: ${p =>
    p.$active
      ? p.theme.colors.bg
      : p.disabled
        ? p.theme.colors.textLight
        : p.theme.colors.text};
  cursor: ${p => (p.disabled ? 'default' : 'pointer')};
  opacity: ${p => (p.disabled ? 0.4 : 1)};
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 1rem;
  padding: 0;
  transition: background 120ms ease;

  &:hover:not(:disabled) {
    background: ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg1)};
  }
`;

/**
 * Color button: a circle filled with the current pen color. Tap cycles to
 * the next swatch. D2 replaces this with the proper Flutter color fan
 * (drag-to-select among 32 colors).
 */
/* `>>> 0` coerces to unsigned 32-bit; slice(2) drops the alpha bytes
 * since the canvas paints ignoring alpha at the toolbar size. */
const colorIntToHex = (c: number): string =>
  `#${(c >>> 0).toString(16).padStart(8, '0').slice(2)}`;

const ColorCircleButton = styled.button<{ $color: number }>`
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: ${p => colorIntToHex(p.$color)};
  border: 2px solid ${p => p.theme.colors.bg2};
  cursor: pointer;
  padding: 0;

  &:hover {
    border-color: ${p => p.theme.colors.text};
  }
`;

/**
 * Width button: a circle with a centered dot whose size mirrors the current
 * stroke width. Tap cycles. D2 replaces this with the fan.
 */
const WidthCircleButton = styled.button`
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  background: transparent;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;

  &:hover {
    background: ${p => p.theme.colors.bg1};
  }
`;

const WidthDot = styled.span<{ $size: number }>`
  width: ${p => p.$size}px;
  height: ${p => p.$size}px;
  border-radius: 50%;
  background: ${p => p.theme.colors.text};
`;
