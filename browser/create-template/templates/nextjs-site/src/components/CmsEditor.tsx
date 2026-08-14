'use client';

import { useEffect } from 'react';
import { useCurrentSubject } from '@/app/context/CurrentSubjectProvider';
import { cmsEditUrl } from '@/atomic/cmsEditUrl';
import { env } from '@/env';
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

/** Cmd/Ctrl+E opens the current page in the Data Browser edit form. */
export function CmsEditHotkey() {
  const { currentSubject } = useCurrentSubject();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'e') {
        return;
      }

      if (event.altKey || event.shiftKey) {
        return;
      }

      if (isTypingTarget(event.target) || !currentSubject) {
        return;
      }

      event.preventDefault();
      openCmsEditor(currentSubject);
    };

    window.addEventListener('keydown', onKeyDown);

    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentSubject]);

  return null;
}

/** Footer affordance for the same edit URL. Hidden until the page subject is known. */
export function CmsEditLink() {
  const { currentSubject } = useCurrentSubject();

  if (!currentSubject) {
    return null;
  }

  return (
    <a
      className={styles.link}
      data-testid='cms-edit-link'
      href={cmsEditUrl(env.NEXT_PUBLIC_ATOMIC_CMS_URL, currentSubject)}
      rel='noreferrer'
      target='_blank'
    >
      Edit this page
    </a>
  );
}
