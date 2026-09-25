import type { RowGrant, RowGrantVia } from '@chunks/AppPage/rowGrant';

/**
 * Making an app a table's view, once the person has answered "may it edit
 * rows?" (#1740).
 *
 * The view is added (or the tab switched) either way; only "Allow editing"
 * records a grant, tied to that view and to the gesture. Setting `view-kind`
 * is never the grant: the server ignores it for writing.
 */
export async function addAppView({
  app,
  view,
  allowEditing,
  createView,
  setViewKind,
  grant,
}: {
  app: { subject: string; name: string };
  /** The tab being switched to the app; absent when adding a new one. */
  view?: string;
  allowEditing: boolean;
  createView: (kind: string, label: string) => Promise<string | undefined>;
  setViewKind: (view: string, kind: string) => Promise<void>;
  grant: (view: string, via: RowGrantVia) => Promise<RowGrant>;
}): Promise<{ view?: string; grant?: RowGrant }> {
  let target = view;

  if (target) {
    await setViewKind(target, app.subject);
  } else {
    target = await createView(app.subject, app.name);
  }

  if (!allowEditing || !target) return { view: target };

  const via: RowGrantVia = view ? 'view-type' : 'add-view';
  const given = await grantWhenSaved(() => grant(target!, via));

  return { view: target, grant: given };
}

/**
 * A grant is refused until the server has the View it names, and a view that
 * was just created or switched may still be on its way there. So a refusal
 * for that reason is retried for a few seconds; any other is the answer.
 */
export async function grantWhenSaved<T>(
  attempt: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms =>
    new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let tries = 0; ; tries++) {
    try {
      return await attempt();
    } catch (e) {
      if (tries >= 10 || !/not a view of this table/.test((e as Error).message))
        throw e;
      await wait(300 * (tries + 1));
    }
  }
}
