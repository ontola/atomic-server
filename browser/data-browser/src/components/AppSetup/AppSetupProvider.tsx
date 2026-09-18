import {
  createContext,
  useContext,
  useState,
  type PropsWithChildren,
} from 'react';
import { useCurrentAgent, useStore } from '@tomic/react';
import { validateSetupArguments, type SetupArguments } from '@tomic/lib';
import { useSettings } from '../../helpers/AppSettings';
import { Dialog, useDialog } from '../Dialog';
import { AppSetupForm } from './AppSetupForm';
import { getAppSetup } from './registry';

const SetupContext = createContext<(app: string, args: unknown) => void>(() => {
  throw new Error('Setup UI is unavailable');
});

export const useAppSetup = () => useContext(SetupContext);

export function AppSetupProvider({ children }: PropsWithChildren) {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const { drive } = useSettings();
  const identity = JSON.stringify([
    store.getServerUrl(),
    drive,
    agent?.subject,
  ]);

  const [request, setRequest] = useState<{
    app: string;
    args: SetupArguments;
    id: string;
    identity: string;
  }>();
  const [dialog, show, close, isOpen] = useDialog();

  const open = (app: string, raw: unknown) => {
    const args = validateSetupArguments(
      getAppSetup(app).declaration,
      raw,
      true,
    );
    if (isOpen && request?.identity === identity)
      throw new Error('Finish or close the current setup first');
    setRequest({ app, args, id: crypto.randomUUID(), identity });
    show();
  };

  return (
    <SetupContext.Provider value={open}>
      {children}
      <Dialog
        {...dialog}
        // Not `isOpen`: that stays true until the close animation has
        // finished, which is only ever reached because the Dialog saw
        // `show` go false. Deriving the prop from it deadlocked the close —
        // `close()` set `dialog.show` to false, this prop stayed true, and
        // the modal sat over the page swallowing every click, including the
        // one on its own close button.
        show={dialog.show && request?.identity === identity}
        width='38rem'
      >
        <Dialog.Title>
          <h2>{request && getAppSetup(request.app).declaration.title}</h2>
        </Dialog.Title>
        <Dialog.Content>
          {isOpen && request?.identity === identity && (
            <AppSetupForm
              key={request.id}
              app={request.app}
              drive={drive}
              initial={request.args}
              onConnected={close}
            />
          )}
        </Dialog.Content>
      </Dialog>
    </SetupContext.Provider>
  );
}
