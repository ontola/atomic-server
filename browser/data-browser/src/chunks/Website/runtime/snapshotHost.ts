// @wc-ignore-file
import { FrameBridge } from '../../../helpers/extensions/FrameBridge';
import { isViewRequest } from '../../../../../plugin/src/viewProtocol';

export interface SnapshotTable {
  title: string;
  columns: string[];
  rows: string[][];
}
/** Same bridge as AppFrame; this host has no credentials, live queries or mutations. */
export function hostSnapshot(frame: HTMLIFrameElement, table: SnapshotTable) {
  return new FrameBridge(frame, (request, session) => {
    if (
      request &&
      typeof request === 'object' &&
      'type' in request &&
      request.type === '__atomic_plugin_rendered'
    ) {
      frame.previousElementSibling
        ?.querySelectorAll<HTMLElement>('.cards, .table-wrap')
        .forEach(element => {
          element.style.display = 'none';
        });

      return;
    }

    if (!isViewRequest(request)) return;
    session.post({
      type: 'atomic.view.response',
      version: 1,
      id: request.id,
      ...(request.op === 'data'
        ? { result: table }
        : { error: 'This published view supports snapshot data only.' }),
    });
  });
}
