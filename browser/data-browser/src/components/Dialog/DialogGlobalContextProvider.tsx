import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FC,
  type PropsWithChildren,
  type RefObject,
} from 'react';
import { styled } from 'styled-components';

interface DialogGlobalContext {
  openDialogs: string[];
  /**
   * The same stack, kept in a ref and written before the state is, so an event
   * handler can ask which dialog is on top *now* rather than as of the last
   * render. See {@link useDialogGlobalContext}.
   */
  openDialogsNow: RefObject<string[]>;
  setDialogOpen: (id: string, open: boolean) => void;
  portal: RefObject<HTMLDivElement | null>;
}

export const DialogContext = createContext<DialogGlobalContext>({
  openDialogs: [],
  openDialogsNow: { current: [] },
  setDialogOpen: () => {},
  portal: { current: null },
});

export const DialogGlobalContextProvider: FC<PropsWithChildren> = ({
  children,
}) => {
  const [openDialogs, setOpenDialogs] = useState<string[]>([]);
  const portalRef = useRef<HTMLDivElement>(null);
  const openDialogsNow = useRef<string[]>([]);

  const setDialogOpen = useCallback((id: string, open: boolean) => {
    // The ref is written here, in the same tick the dialog registers itself,
    // while the state below only lands when React gets round to re-rendering.
    openDialogsNow.current = open
      ? openDialogsNow.current.includes(id)
        ? openDialogsNow.current
        : [...openDialogsNow.current, id]
      : openDialogsNow.current.filter(dialogId => dialogId !== id);

    if (open) {
      setOpenDialogs(prev => {
        if (prev.includes(id)) {
          return prev;
        }

        return [...prev, id];
      });
    } else {
      setOpenDialogs(prev => prev.filter(dialogId => dialogId !== id));
    }
  }, []);

  const context = useMemo(
    () => ({ openDialogs, openDialogsNow, setDialogOpen, portal: portalRef }),
    [openDialogs, setDialogOpen, portalRef],
  );

  return (
    <DialogContext.Provider value={context}>
      {children}
      <StyledDiv ref={portalRef}></StyledDiv>
    </DialogContext.Provider>
  );
};

export function useDialogGlobalContext(open: boolean) {
  const id = useId();
  const { openDialogs, openDialogsNow, setDialogOpen, ...context } =
    useContext(DialogContext);

  const isTopLevel = openDialogs.at(-1) === id;

  /**
   * Whether this dialog is on top at the moment it is asked, which is not the
   * same question as `isTopLevel`.
   *
   * A stacked dialog registers itself from an effect, in the same flush that
   * calls `showModal()`. The state update that follows is ordinary priority,
   * so React is free to leave it for later while the main thread is busy: for
   * that stretch both dialogs are `open` in the DOM and the one underneath
   * still reads `isTopLevel === true`. An Escape landing in that window closes
   * BOTH, because the browser sends `cancel` to the real topmost dialog while
   * the one underneath answers the keydown itself. `calendar.spec:106` caught
   * exactly that: two open dialogs, one Escape, and a count of zero.
   *
   * So anything deciding in an event handler asks this, and only what is
   * rendered reads `isTopLevel`.
   */
  const isTopLevelNow = useCallback(() => {
    const stack = openDialogsNow.current;

    return stack.length === 0 || stack.at(-1) === id;
  }, [openDialogsNow, id]);

  useEffect(() => {
    setDialogOpen(id, open);
  }, [open, id]);

  return {
    isTopLevel,
    isTopLevelNow,
    ...context,
  };
}

const StyledDiv = styled.div`
  display: contents;
`;
