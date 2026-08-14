'use client';

import { useEffect } from 'react';
import { useCurrentSubject } from '@/app/context/CurrentSubjectProvider';
import { cmsEditUrl } from '@/atomic/cmsEditUrl';
import { env } from '@/env';
import { useInPlaceEdit } from '@/components/InPlaceEdit';
import styles from './CmsEditor.module.css';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  if (target.isContentEditable) {
    return true;
  }

  const tag = target.tagName;

  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function openCmsEditor(subject: string) {
  window.open(
    cmsEditUrl(env.NEXT_PUBLIC_ATOMIC_CMS_URL, subject),
    '_blank',
    'noopener,noreferrer',
  );
}

/** Cmd/Ctrl+E enters in-place edit. Cmd/Ctrl+Shift+E opens the Data Browser. */
export function CmsEditHotkey() {
  const { currentSubject } = useCurrentSubject();
  const { enterEdit, exitEdit, editing } = useInPlaceEdit();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') {
        return;
      }

      if (event.altKey) {
        return;
      }

      if (isTypingTarget(event.target) || !currentSubject) {
        return;
      }

      event.preventDefault();

      if (event.shiftKey) {
        openCmsEditor(currentSubject);
        return;
      }

      if (editing) {
        exitEdit();
      } else {
        enterEdit();
      }
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSubject, editing, enterEdit, exitEdit]);

  return null;
}

/** Footer control for in-place editing. Hidden until the page subject is known. */
export function CmsEditLink() {
  const { currentSubject } = useCurrentSubject();
  const { enterEdit, exitEdit, editing } = useInPlaceEdit();

  if (!currentSubject) {
    return null;
  }

  return (
    <button
      className={styles.link}
      data-testid='cms-edit-link'
      type='button'
      onClick={editing ? exitEdit : enterEdit}
    >
      {editing ? 'Done editing' : 'Edit this page'}
    </button>
  );
}
