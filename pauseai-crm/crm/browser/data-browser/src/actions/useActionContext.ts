import { useCanWrite, useDrive, useResource, useStore } from '@tomic/react';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { useQueryScopeHandler } from '../hooks/useQueryScope';
import { useNewRoute } from '../helpers/useNewRoute';
import { useFavorites } from '../hooks/useFavorites';
import {
  newContextItem,
  useAISidebar,
} from '../components/AI/AISidebarContext';
import { type AIAtomicResourceMessageContext } from '@chunks/AI/types';
import type { ActionContext } from './types';

/** Capabilities and callbacks the consuming surface provides. */
export interface ActionContextOverrides {
  external?: boolean;
  showCodeUsageDialog?: () => void;
  openEmojiPicker?: () => void;
  openCoverPicker?: () => void;
  onAfterDelete?: () => void;
}

/**
 * Assembles the {@link ActionContext} for a target resource — everything the
 * action definitions need at render (available/disabled/label) and run time.
 */
export function useActionContext(
  subject: string,
  overrides: ActionContextOverrides = {},
): ActionContext {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const resource = useResource(subject);
  const canWrite = useCanWrite(resource);
  const [currentSubject] = useCurrentSubject();
  const { enableScope } = useQueryScopeHandler(subject);
  const addChild = useNewRoute(subject);
  const [favorites, addFavorite, removeFavorite] = useFavorites();
  const { setContextItems, isOpen, setIsOpen } = useAISidebar();
  const [drive] = useDrive();

  const addToChat = () => {
    setContextItems(prev => [
      ...prev.filter(
        x => x.type === 'atomic-resource' && x.subject !== subject,
      ),
      newContextItem({
        type: 'atomic-resource',
        subject,
      } as AIAtomicResourceMessageContext),
    ]);

    if (!isOpen) {
      setIsOpen(true);
    }
  };

  return {
    store,
    navigate,
    subject,
    resource,
    canWrite,
    currentSubject,
    pathname: window.location.pathname,
    isFavorite: favorites.includes(subject),
    addFavorite,
    removeFavorite,
    addToChat,
    enableScope,
    addChild,
    drive,
    ...overrides,
  };
}
