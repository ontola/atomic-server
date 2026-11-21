// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { appPanelSubjects } from '@chunks/AppPage/useDriveApps';
import { Panel, usePanelList } from './usePanelList';

describe('appPanelSubjects', () => {
  it('lists drive apps before installations, once each', () => {
    expect(appPanelSubjects(['a', 'b'], ['c', 'a'])).toEqual(['a', 'b', 'c']);
  });
});

describe('Apps panel preference', () => {
  beforeEach(() => localStorage.clear());

  it('shows by default and can be hidden and shown again', () => {
    const { result } = renderHook(() => usePanelList());
    expect(result.current.enabledPanels.has(Panel.Apps)).toBe(true);

    act(() => result.current.disablePanel(Panel.Apps));
    expect(result.current.enabledPanels.has(Panel.Apps)).toBe(false);

    act(() => result.current.enablePanel(Panel.Apps));
    expect(result.current.enabledPanels.has(Panel.Apps)).toBe(true);
  });
});
