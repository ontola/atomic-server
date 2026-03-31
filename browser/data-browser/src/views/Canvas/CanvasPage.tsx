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
} from '@tomic/lib';
import type { ResourcePageProps } from '@views/ResourcePage';
import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';
import { drawCanvasStrokes, screenToCanvas } from './canvas-draw';

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

  const scaleRef = useRef(scale);
  const offsetRef = useRef(offset);
  const strokesRef = useRef(strokes);
  const currentStrokeRef = useRef(currentStroke);
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

  const reloadStrokesFromResource = useCallback((res: Resource) => {
    setStrokes(parseCanvasStrokes(res.get(canvas.properties.strokeData)));
  }, []);

  useEffect(() => {
    reloadStrokesFromResource(resource);

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
      strokesRef.current,
      currentStrokeRef.current,
      scaleRef.current,
      offsetRef.current.x,
      offsetRef.current.y,
      darkMode,
    );
  }, [darkMode]);

  useEffect(() => {
    paint();
  }, [paint, strokes, currentStroke, scale, offset]);

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const ro = new ResizeObserver(() => paint());
    ro.observe(container);
    return () => ro.disconnect();
  }, [paint]);

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
  };

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
          zoom
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
