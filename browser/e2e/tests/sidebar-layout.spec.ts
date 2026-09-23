import { test, expect, type Page } from './fixtures';
import { before } from './test-utils';

test.beforeEach(before);

/** Sample an actual layout transition at a fixed time instead of racing a timer. */
async function sampleToggle(page: Page, side: 'left' | 'right') {
  return page.evaluate(async edge => {
    const main = document.querySelector('main')!;
    const sidebar = document.querySelector('[data-testid="sidebar"]')!;
    const slot =
      edge === 'left'
        ? sidebar.parentElement!
        : document.querySelector('[data-testid="ai-sidebar"]')!;
    const trigger = document.querySelector<HTMLButtonElement>(
      edge === 'left'
        ? 'button[title^="Show / hide sidebar"]'
        : '[data-testid="navbar-ai-button"]',
    )!;
    const frame = () =>
      new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    const measure = () => {
      const bounds = main.getBoundingClientRect();

      return {
        x: bounds.x,
        width: bounds.width,
        sidebarWidth: sidebar.getBoundingClientRect().width,
      };
    };

    const start = measure();
    trigger.click();
    let animation: Animation | undefined;

    for (let i = 0; i < 30 && !animation; i++) {
      await frame();
      animation = slot
        .getAnimations()
        .find(
          candidate =>
            candidate instanceof CSSTransition &&
            candidate.transitionProperty === 'width',
        );
    }

    if (!animation)
      throw new Error(`${edge} sidebar did not animate its layout width`);
    animation.pause();
    animation.currentTime = 150;
    await frame();
    const middle = measure();
    animation.finish();
    await frame();

    return {
      start,
      middle,
      end: measure(),
      timing: animation.effect!.getTiming(),
    };
  }, side);
}

test('both docked sidebars animate the main content on opening and closing', async ({
  page,
}) => {
  await page.mouse.move(600, 40);
  const closeLeft = await sampleToggle(page, 'left');
  expect(closeLeft.middle.x).toBeGreaterThan(closeLeft.end.x);
  expect(closeLeft.middle.x).toBeLessThan(closeLeft.start.x);
  expect(closeLeft.middle.width).toBeGreaterThan(closeLeft.start.width);
  expect(closeLeft.middle.width).toBeLessThan(closeLeft.end.width);
  expect(closeLeft.middle.sidebarWidth).toBe(closeLeft.start.sidebarWidth);

  const openLeft = await sampleToggle(page, 'left');
  expect(openLeft.middle.x).toBeGreaterThan(openLeft.start.x);
  expect(openLeft.middle.x).toBeLessThan(openLeft.end.x);
  expect(openLeft.end.x).toBe(closeLeft.start.x);

  const openRight = await sampleToggle(page, 'right');
  expect(openRight.middle.width).toBeLessThan(openRight.start.width);
  expect(openRight.middle.width).toBeGreaterThan(openRight.end.width);
  expect(openRight.timing.duration).toBe(openLeft.timing.duration);
  expect(openRight.timing.easing).toBe(openLeft.timing.easing);

  const closeRight = await sampleToggle(page, 'right');
  expect(closeRight.middle.width).toBeGreaterThan(closeRight.start.width);
  expect(closeRight.middle.width).toBeLessThan(closeRight.end.width);
  expect(closeRight.end.width).toBe(openRight.start.width);
});

test('resizing a docked sidebar keeps the page aligned with the dragged edge', async ({
  page,
}) => {
  const sidebar = page.getByTestId('sidebar');
  const main = page.getByRole('main');
  const initial = (await sidebar.boundingBox())!;
  const initialMain = (await main.boundingBox())!;
  const edge = initial.x + initial.width - 2;
  await page.mouse.move(edge, 180);
  await page.mouse.down();
  await page.mouse.move(edge + 80, 180);
  await expect
    .poll(async () => (await sidebar.boundingBox())!.width)
    .toBe(initial.width + 78);
  const resized = (await main.boundingBox())!;
  expect(resized.x).toBe(initialMain.x + 78);
  expect(resized.width).toBe(initialMain.width - 78);
  await page.mouse.up();
  await page.mouse.move(600, 40);
  await sampleToggle(page, 'left');
  const reopened = await sampleToggle(page, 'left');
  expect(reopened.end.x).toBe(resized.x);
});

test('hover reveals the unlocked sidebar without moving the page', async ({
  page,
}) => {
  await page.mouse.move(600, 40);
  await sampleToggle(page, 'left');
  const main = page.getByRole('main');
  const initial = await main.boundingBox();
  await page.mouse.move(2, 200);
  await expect(page.getByTestId('sidebar')).toHaveCSS('opacity', '1');
  expect(await main.boundingBox()).toEqual(initial);
  await page.mouse.move(600, 200);
  await expect(page.getByTestId('sidebar')).toHaveCSS('opacity', '0');
  expect(await main.boundingBox()).toEqual(initial);
});

test('mobile sidebar stays an overlay and closes from its backdrop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('sideBarOpen', 'false'));
  await page.reload();
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toHaveCSS('opacity', '0');
  const main = page.getByRole('main');
  const initial = await main.boundingBox();
  await page.getByRole('button', { name: /Show \/ hide sidebar/ }).click();
  await expect(sidebar).toHaveCSS('opacity', '1');
  expect(await main.boundingBox()).toEqual(initial);
  await page.mouse.click(370, 200);
  await expect(sidebar).toHaveCSS('opacity', '0');
  expect(await main.boundingBox()).toEqual(initial);
});

test('mobile resource actions keep the menu on screen', async ({ page }) => {
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });

    const menuTrigger = page.locator('[data-test="context-menu"]');
    await expect(menuTrigger).toBeVisible();
    await expect(
      page.getByTestId('navbar-tags-button').locator('span'),
    ).toHaveCSS('display', 'none');

    const bounds = await menuTrigger.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);

    await menuTrigger.click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.keyboard.press('Escape');
  }
});
