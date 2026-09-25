import type { JSX } from 'react';

/**
 * What a person agrees to when they let an app edit a table's rows (#1740).
 * One text for every place that asks: adding the app as a view, switching a
 * tab to it, and the app's own request.
 */
export function RowGrantText({ appName }: { appName: string }): JSX.Element {
  return (
    <>
      <strong>{appName}</strong> can edit rows in this table. It can fill in the
      table&apos;s columns and add rows, but not delete rows or change the table
      itself. You can take this back from the tab&apos;s menu.
    </>
  );
}
