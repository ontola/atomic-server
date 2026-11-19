import { useEffect, useRef } from 'react';
import { dataBrowser, unknownSubject, useResource } from '@tomic/react';
import { openNative } from './hostActions';

/**
 * A chat room or meeting opened in the page (a link to one, a folder's child)
 * is shown by the app's native screen when it has one: `onOpened` runs once
 * the app has taken over (the page then goes back to where the link was).
 * When the app has no such screen the page keeps drawing it itself.
 */
export function useNativeChatRoom(subject: string, onOpened: () => void): void {
  const resource = useResource(subject || unknownSubject);
  const kind = resource.hasClasses(dataBrowser.classes.chatroom)
    ? dataBrowser.classes.chatroom
    : resource.hasClasses(dataBrowser.classes.meeting)
      ? dataBrowser.classes.meeting
      : undefined;
  const title = resource.title;
  const asked = useRef<string | undefined>(undefined);
  const opened = useRef(onOpened);

  opened.current = onOpened;

  useEffect(() => {
    if (!kind || asked.current === subject) return;
    asked.current = subject;
    void openNative(kind, subject, title).then(handled => {
      if (handled) opened.current();
    });
  }, [kind, subject, title]);
}
