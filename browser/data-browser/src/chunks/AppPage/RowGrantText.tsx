import type { JSX } from 'react';

/**
 * What a person agrees to when they let an app edit a table's rows (#1740).
 * One text for every place that asks: adding the app as a view, switching a
 * tab to it, and the app's own request.
 *
 * `keepsExtras` when the app declares `row-extras` (#1849): it will also
 * write its own bookkeeping, such as a sync's provider id and version, on the
 * rows. Those are not columns, so the text says where they do show up.
 */
export function RowGrantText({
  appName,
  keepsExtras = false,
}: {
  appName: string;
  keepsExtras?: boolean;
}): JSX.Element {
  // A sentence of its own, so it is translated as one rather than folded
  // into the surrounding message as an argument.
  const extras = keepsExtras
    ? 'It also keeps its own sync information on the rows. That is not shown as columns, only under "Kept by apps" when you open a row. '
    : '';

  return (
    <>
      <strong>{appName}</strong> can edit rows in this table. It can fill in the
      table&apos;s columns and add rows, but not delete rows or change the table
      itself. {extras}You can take this back from the tab&apos;s menu.
    </>
  );
}
