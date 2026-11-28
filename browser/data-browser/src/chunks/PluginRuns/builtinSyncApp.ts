// @wc-ignore-file
import type { ConnectionReference } from '@helpers/proxyConnections';
import type {
  PrincipalChoice,
  PrincipalChooserContext,
} from './builtinSyncablesProfile';

/** Only the existing view bridge operations the account chooser uses. */
export interface PrincipalChooserStore {
  getContext(): Promise<PrincipalChooserContext>;
  proxy: {
    connections(args: { platform: string }): Promise<ConnectionReference[]>;
    connect(args: {
      platform: string;
      connectionId?: string;
    }): Promise<
      { status: 'connected'; connectionId: string } | { status: 'cancelled' }
    >;
  };
  ui: {
    openResource(
      subject: string,
      principal?: PrincipalChoice,
    ): Promise<unknown>;
  };
}

export function createPrincipalChooser(
  store: PrincipalChooserStore,
  context: PrincipalChooserContext,
) {
  return {
    openPrincipal(connectionId: string) {
      return store.ui.openResource(context.subject, {
        kind: 'authenticated',
        connectionId,
      });
    },
    openPublic() {
      return store.ui.openResource(context.subject, { kind: 'public' });
    },
  };
}

export async function view({
  root,
  store,
}: {
  root: HTMLElement;
  store: PrincipalChooserStore;
}) {
  const context = await store.getContext();
  const chooser = createPrincipalChooser(store, context);
  const style = document.createElement('style');
  style.textContent =
    ':root{font-family:"Open Sans","Segoe UI",sans-serif;color-scheme:light dark}body{margin:0;padding:12px;font-size:14px}.choices{display:flex;gap:10px;flex-wrap:wrap}button{font:inherit;cursor:pointer;padding:7px 12px;border:1px solid #aaa;border-radius:8px;color:inherit;background:transparent}button:disabled{opacity:.55}';
  document.head.append(style);
  const message = document.createElement('p');
  message.setAttribute('role', 'alert');
  message.hidden = true;

  const fail = (reason: unknown) => {
    message.hidden = false;
    message.textContent =
      reason instanceof Error ? reason.message : String(reason);
  };

  root.append(message);

  if (context.preferredConnectionId) {
    try {
      await chooser.openPrincipal(context.preferredConnectionId);

      return;
    } catch (error) {
      fail(error);
    }
  }

  const heading = document.createElement('h3');
  heading.textContent = 'Connected principals';
  const choices = document.createElement('div');
  choices.className = 'choices';

  const button = (
    label: string,
    action: () => Promise<unknown>,
    destination = choices,
  ) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.textContent = label;
    node.addEventListener('click', async () => {
      node.disabled = true;
      message.hidden = true;

      try {
        await action();
      } catch (error) {
        fail(error);
      } finally {
        node.disabled = false;
      }
    });
    destination.append(node);
  };

  const connect = async (connectionId?: string) => {
    const result = await store.proxy.connect({
      platform: context.platform,
      ...(connectionId ? { connectionId } : {}),
    });
    if (result?.status === 'connected')
      await chooser.openPrincipal(result.connectionId);
  };

  root.append(heading, choices);
  button('Connect account', () => connect());
  if (
    context.publicAvailable &&
    !context.principalApps.some(app => app.principal.kind === 'public')
  )
    button('Public', chooser.openPublic);

  for (const app of context.principalApps)
    button(app.name, () => store.ui.openResource(app.subject));

  try {
    const connections = await store.proxy.connections({
      platform: context.platform,
    });

    if (
      connections.length === 0 &&
      !context.principalApps.some(app => app.principal.kind === 'authenticated')
    ) {
      const status = document.createElement('p');
      status.textContent = 'No accounts connected yet.';
      root.append(status);
    }

    for (const connection of connections) {
      const current = context.principalApps.find(
        app => app.connectionId === connection.connectionId,
      );
      const label = connection.label ?? current?.name ?? 'Connected account';
      if (!current)
        button(label, () => chooser.openPrincipal(connection.connectionId));
      if (connection.canReconnect)
        button('Reconnect ' + label, () => connect(connection.connectionId));
    }
  } catch (error) {
    fail(error);
  }
}
