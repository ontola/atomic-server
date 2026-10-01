import type { CDPSession } from '@playwright/test';
import { test, expect, type Page } from './fixtures';
import { before, devDrive, newResource } from './test-utils';

const CANVAS_CLASS = 'https://atomicdata.dev/ontology/canvas/Canvas';
const STROKE_DATA = 'https://atomicdata.dev/ontology/canvas/strokeData';

type StoreWindow = {
  store: {
    getResourceLoading: (subject: string) => {
      get: (prop: string) => unknown;
    };
  };
};

type Element = {
  kind?: string;
  text?: string;
  path: [number, number][];
  w?: number;
};

/** Elements of the currently-open canvas, read from the live Store. */
async function elements(page: Page): Promise<Element[]> {
  return page.evaluate(prop => {
    const store = (window as unknown as StoreWindow).store;
    const subject = decodeURIComponent(
      new URLSearchParams(location.search).get('subject')!,
    );
    const raw = store.getResourceLoading(subject).get(prop);

    return Array.isArray(raw) ? (raw as Element[]) : [];
  }, STROKE_DATA);
}

async function canvasPixels(page: Page): Promise<string> {
  return page
    .locator('canvas')
    .first()
    .evaluate(el => (el as HTMLCanvasElement).toDataURL());
}

type Point = { x: number; y: number };

const sessions = new WeakMap<Page, CDPSession>();

/** One CDP session per page: Chromium tracks the touch state in it. */
async function cdp(page: Page): Promise<CDPSession> {
  let session = sessions.get(page);

  if (!session) {
    session = await page.context().newCDPSession(page);
    sessions.set(page, session);
  }

  return session;
}

/** Dispatch raw touch events: every call carries all fingers currently down. */
async function touch(
  page: Page,
  type: 'touchStart' | 'touchMove' | 'touchEnd',
  points: Point[],
) {
  await (
    await cdp(page)
  ).send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p, id) => ({ x: p.x, y: p.y, id })),
  });
}

async function drawWithMouse(page: Page, from: Point, to: Point) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, {
    steps: 4,
  });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

async function openCanvas(page: Page) {
  await devDrive(page);
  await newResource(CANVAS_CLASS, page);

  const canvas = page.locator('canvas').first();
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;

  return { cx: box.x + box.width / 2, cy: box.y + box.height / 3 };
}

test.describe('canvas touch and tools', () => {
  test.use({ hasTouch: true });
  test.beforeEach(before);

  test('without a pen one finger draws and two fingers pan and zoom', async ({
    page,
  }) => {
    const { cx, cy } = await openCanvas(page);

    // One finger draws.
    await touch(page, 'touchStart', [{ x: cx - 80, y: cy }]);
    await touch(page, 'touchMove', [{ x: cx - 20, y: cy + 30 }]);
    await touch(page, 'touchMove', [{ x: cx + 40, y: cy }]);
    await touch(page, 'touchEnd', []);
    await expect.poll(async () => (await elements(page)).length).toBe(1);

    // Two fingers spreading zoom; the drawing repaints and no stroke is added.
    const pixelsBefore = await canvasPixels(page);
    const a = { x: cx - 30, y: cy + 100 };
    const b = { x: cx + 30, y: cy + 100 };

    await touch(page, 'touchStart', [a]);
    await touch(page, 'touchStart', [a, b]);

    for (let i = 1; i <= 6; i++) {
      await touch(page, 'touchMove', [
        { x: a.x - i * 15, y: a.y },
        { x: b.x + i * 15, y: b.y },
      ]);
    }

    await touch(page, 'touchEnd', []);

    await expect.poll(() => canvasPixels(page)).not.toBe(pixelsBefore);
    expect(await elements(page)).toHaveLength(1);
  });

  test('once a pen is seen one finger pans instead of drawing', async ({
    page,
  }) => {
    const { cx, cy } = await openCanvas(page);

    await drawWithMouse(page, { x: cx - 60, y: cy }, { x: cx + 60, y: cy });
    await expect.poll(async () => (await elements(page)).length).toBe(1);

    // A pen hovering over the canvas is enough to detect it.
    await (
      await cdp(page)
    ).send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: cx,
      y: cy + 50,
      pointerType: 'pen',
    });
    await expect(page.locator('[data-pen-detected="true"]')).toBeVisible();

    const pixelsBefore = await canvasPixels(page);

    await touch(page, 'touchStart', [{ x: cx, y: cy + 80 }]);
    await touch(page, 'touchMove', [{ x: cx + 60, y: cy + 120 }]);
    await touch(page, 'touchMove', [{ x: cx + 120, y: cy + 160 }]);
    await touch(page, 'touchEnd', []);

    await expect.poll(() => canvasPixels(page)).not.toBe(pixelsBefore);
    expect(await elements(page)).toHaveLength(1);
  });

  test('lasso selects strokes and moves them', async ({ page }) => {
    const { cx, cy } = await openCanvas(page);

    await drawWithMouse(page, { x: cx - 40, y: cy }, { x: cx + 40, y: cy });
    await expect.poll(async () => (await elements(page)).length).toBe(1);
    const startX = (await elements(page))[0].path[0][0];

    await page.getByRole('button', { name: 'Lasso tool' }).click();

    // Loop around the stroke.
    await page.mouse.move(cx - 90, cy - 50);
    await page.mouse.down();

    for (const [dx, dy] of [
      [90, -50],
      [90, 50],
      [-90, 50],
      [-90, -50],
    ]) {
      await page.mouse.move(cx + dx, cy + dy, { steps: 4 });
    }

    await page.mouse.up();
    await expect(
      page.getByRole('button', { name: 'Delete selection' }),
    ).toBeVisible();

    // Drag inside the selection box.
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 100, cy + 40, { steps: 6 });
    await page.mouse.up();

    await expect
      .poll(async () => (await elements(page))[0].path[0][0])
      .not.toBe(startX);
    expect(await elements(page)).toHaveLength(1);

    await page.getByRole('button', { name: 'Delete selection' }).click();
    await expect.poll(async () => (await elements(page)).length).toBe(0);
  });

  test('text tool adds typed text', async ({ page }) => {
    const { cx, cy } = await openCanvas(page);

    await page.getByRole('button', { name: 'Text tool' }).click();
    await page.mouse.click(cx - 50, cy);
    await page.getByLabel('Canvas text').fill('hello canvas');
    await page.mouse.click(cx + 150, cy + 150);

    await expect.poll(async () => (await elements(page)).length).toBe(1);
    expect((await elements(page))[0]).toMatchObject({
      kind: 'text',
      text: 'hello canvas',
    });
  });

  test('image tool places a picture', async ({ page }) => {
    await openCanvas(page);

    // 1×1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
      'base64',
    );

    await page
      .getByLabel('Choose an image', { exact: true })
      .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });

    await expect.poll(async () => (await elements(page)).length).toBe(1);
    expect((await elements(page))[0]).toMatchObject({ kind: 'image' });
    await expect(
      page.getByRole('button', { name: 'Delete selection' }),
    ).toBeVisible();
  });
});
