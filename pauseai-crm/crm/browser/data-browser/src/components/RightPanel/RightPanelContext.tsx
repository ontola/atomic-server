import React, {
  useCallback,
  useContext,
  createContext,
  useEffect,
  useState,
} from 'react';
import { useLocalStorage } from '../../hooks/useLocalStorage';

export type RightPanelId = 'ai' | 'comments' | 'followSession';

/**
 * Manages which panel occupies the right side of the screen. Panels are
 * mutually exclusive: opening one closes the other.
 */
const RightPanelContext = createContext<{
  activePanel: RightPanelId | null;
  setPanelOpen: (
    panel: RightPanelId,
    action: React.SetStateAction<boolean>,
  ) => void;
  togglePanel: (panel: RightPanelId) => void;
  selectedMeeting: string | undefined;
  openMeetingPanel: (subject: string) => void;
}>({
  activePanel: null,
  setPanelOpen: () => {},
  togglePanel: () => {},
  selectedMeeting: undefined,
  openMeetingPanel: () => {},
});

export const useRightPanel = () => useContext(RightPanelContext);

export const RightPanelProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [activePanel, setActivePanel] = useLocalStorage<RightPanelId | null>(
    'atomic.rightPanel.active',
    null,
  );
  const [selectedMeeting, setSelectedMeeting] = useState<string>();

  const setPanelOpen = useCallback(
    (panel: RightPanelId, action: React.SetStateAction<boolean>) => {
      setActivePanel(prev => {
        const isOpen = prev === panel;
        const open = typeof action === 'function' ? action(isOpen) : action;

        if (open) {
          return panel;
        }

        return isOpen ? null : prev;
      });
    },
    [setActivePanel],
  );

  const togglePanel = useCallback(
    (panel: RightPanelId) => setPanelOpen(panel, open => !open),
    [setPanelOpen],
  );

  const openMeetingPanel = useCallback(
    (subject: string) => {
      setSelectedMeeting(subject);
      setPanelOpen('followSession', true);
    },
    [setPanelOpen],
  );

  useEffect(() => {
    if (activePanel !== 'followSession') {
      setSelectedMeeting(undefined);
    }
  }, [activePanel]);

  return (
    <RightPanelContext.Provider
      value={{
        activePanel,
        setPanelOpen,
        togglePanel,
        selectedMeeting,
        openMeetingPanel,
      }}
    >
      {children}
    </RightPanelContext.Provider>
  );
};
