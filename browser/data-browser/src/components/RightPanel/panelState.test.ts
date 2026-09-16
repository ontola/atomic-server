import { describe, expect, it } from 'vitest';
import { AtomicError, ErrorType } from '@tomic/react';
import {
  closePanelState,
  emptyPanelState,
  updatePanelState,
  type PanelState,
} from './panelState';
import { panelTargetAvailable } from './useContextualPanel';

const meeting: PanelState = {
  scope: 'alice/drive-one',
  activePanel: 'followSession',
  selectedMeeting: 'did:ad:meeting',
};

describe('right panel lifecycle', () => {
  it('starts closed and without a selected meeting', () => {
    expect(emptyPanelState('alice/drive-one')).toEqual({
      scope: 'alice/drive-one',
      activePanel: null,
    });
  });
  it('clears the meeting when another panel opens or it is closed', () => {
    expect(updatePanelState(meeting, meeting.scope, 'comments', true)).toEqual({
      scope: meeting.scope,
      activePanel: 'comments',
      selectedMeeting: undefined,
    });
    expect(
      updatePanelState(meeting, meeting.scope, 'followSession', false)
        .selectedMeeting,
    ).toBeUndefined();
  });
  it('closing an inactive panel does not close the current one', () => {
    expect(updatePanelState(meeting, meeting.scope, 'comments', false)).toEqual(
      meeting,
    );
  });
  it.each(['bob/drive-one', 'alice/drive-two'])(
    'does not carry panel context into %s or accept an old callback',
    scope => {
      const switched = emptyPanelState(scope);
      expect(switched.activePanel).toBeNull();
      expect(switched.selectedMeeting).toBeUndefined();
      expect(
        updatePanelState(switched, meeting.scope, 'followSession', true),
      ).toBe(switched);
      expect(
        updatePanelState(switched, scope, 'followSession', true)
          .selectedMeeting,
      ).toBeUndefined();
    },
  );
  it('toggle operations use the current state', () => {
    const open = updatePanelState(
      emptyPanelState('a'),
      'a',
      'ai',
      value => !value,
    );
    expect(open.activePanel).toBe('ai');
    expect(
      updatePanelState(open, 'a', 'ai', value => !value).activePanel,
    ).toBeNull();
  });
  it('switches threads instead of closing when aimed at another row', () => {
    const rowOne = updatePanelState(
      emptyPanelState('a'),
      'a',
      'comments',
      open => !open,
      'did:ad:row-one',
    );
    expect(rowOne).toMatchObject({
      activePanel: 'comments',
      commentSubject: 'did:ad:row-one',
    });

    // Another row: an open, not a toggle.
    const rowTwo = updatePanelState(
      rowOne,
      'a',
      'comments',
      open => !open,
      'did:ad:row-two',
    );
    expect(rowTwo).toMatchObject({
      activePanel: 'comments',
      commentSubject: 'did:ad:row-two',
    });

    // The same row again closes the panel.
    expect(
      updatePanelState(rowTwo, 'a', 'comments', open => !open, 'did:ad:row-two')
        .activePanel,
    ).toBeNull();

    // The NavBar button carries no target: it comes back to the page's own
    // thread rather than closing the row's.
    const page = updatePanelState(rowTwo, 'a', 'comments', open => !open);
    expect(page.activePanel).toBe('comments');
    expect(page.commentSubject).toBeUndefined();
  });
  it('drops the comment target when another panel takes over or it closes', () => {
    const row: PanelState = {
      scope: 'a',
      activePanel: 'comments',
      commentSubject: 'did:ad:row-one',
    };
    expect(
      updatePanelState(row, 'a', 'followSession', true).commentSubject,
    ).toBeUndefined();
    expect(closePanelState(row, 'a', 'comments')).toEqual(emptyPanelState('a'));
  });
  it('closes a panel whatever it is aimed at, and leaves the others alone', () => {
    // A close request carries no target, so toggling cannot express it: it
    // would read as "close the page's thread" and leave the row's open.
    const row: PanelState = {
      scope: 'a',
      activePanel: 'comments',
      commentSubject: 'did:ad:row-one',
    };
    expect(updatePanelState(row, 'a', 'comments', false)).toEqual(row);
    expect(closePanelState(row, 'a', 'ai')).toBe(row);
    expect(closePanelState(row, 'other-scope', 'comments')).toBe(row);
  });
  it('closes targets that disappeared or lost access, without treating offline/loading as deletion', () => {
    expect(panelTargetAvailable()).toBe(false);
    expect(panelTargetAvailable('meeting')).toBe(true);
    for (const type of [ErrorType.NotFound, ErrorType.Unauthorized])
      expect(
        panelTargetAvailable('meeting', new AtomicError('gone', type)),
      ).toBe(false);
    for (const type of [ErrorType.Transport, ErrorType.Server])
      expect(
        panelTargetAvailable('meeting', new AtomicError('retry', type)),
      ).toBe(true);
  });
});
