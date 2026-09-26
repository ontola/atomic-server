import { describe, it, expect, vi } from 'vitest';
import { createBackStack } from './androidBack';

function setup() {
  let fire: ((p: { canGoBack: boolean }) => void)[] = [];
  const unregister = vi.fn(async () => {});
  const register = vi.fn(async (cb: (p: { canGoBack: boolean }) => void) => {
    fire.push(cb);

    return { unregister };
  });
  const stack = createBackStack(register);
  const press = () => fire.forEach(cb => cb({ canGoBack: true }));

  return { stack, register, unregister, press, reset: () => (fire = []) };
}

const flush = () => new Promise(r => setTimeout(r, 0));

describe('back stack', () => {
  it('listens only while something wants back', async () => {
    const { stack, register, unregister } = setup();
    expect(register).not.toHaveBeenCalled();

    const pop = stack.push(() => {});
    expect(register).toHaveBeenCalledTimes(1);

    pop();
    await flush();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('closes the most recent thing first', async () => {
    const { stack, press } = setup();
    const drawer = vi.fn();
    const dialog = vi.fn();
    stack.push(drawer);
    const popDialog = stack.push(dialog);
    await flush();

    press();
    expect(dialog).toHaveBeenCalledTimes(1);
    expect(drawer).not.toHaveBeenCalled();

    popDialog();
    press();
    expect(drawer).toHaveBeenCalledTimes(1);
  });

  it('acts once when a listener being removed fires alongside a new one', async () => {
    const { stack, press } = setup();
    const first = vi.fn();
    const second = vi.fn();
    stack.push(first)();
    stack.push(second);
    await flush();

    press();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
