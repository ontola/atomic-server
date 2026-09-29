import { commits, core, useResource, dataBrowser } from '@tomic/react';
import { useEffect, type JSX } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import AllProps from '@components/AllProps';
import { useTableEditorContext } from '@chunks/TableEditor/TableEditorContext';
import { Title } from '@components/Title';
import {
  CalendarRowFields,
  readRowRepeat,
  type CalendarRowContext,
} from './Calendar/CalendarRowFields';

interface ExpandedRowDialogProps {
  subject: string;
  open: boolean;
  bindOpen: (open: boolean) => void;
  /** The row's calendar fields (Repeat), shown instead of their raw values.
   * Both the calendar and the table view pass them. */
  calendar?: CalendarRowContext;
}

const EXCLUDED_PROPS = [
  commits.properties.lastCommit,
  core.properties.parent,
  core.properties.isA,
  dataBrowser.properties.subResources,
];

export function ExpandedRowDialog({
  subject,
  open,
  bindOpen,
  calendar,
}: ExpandedRowDialogProps): JSX.Element {
  const { tableRef } = useTableEditorContext();
  const resource = useResource(subject);
  const [dialogProps, show] = useDialog({
    bindShow: bindOpen,
    triggerRef: tableRef,
  });

  // The Repeat field stands in for the recurrence property's JSON editor,
  // unless the row has no day to repeat from: then the JSON stays.
  const repeatProp =
    calendar?.recurrenceProp &&
    readRowRepeat(subject, prop => resource.get(prop), calendar).anchor
      ? calendar.recurrenceProp.subject
      : undefined;

  useEffect(() => {
    if (open) {
      show();
    }
  }, [open, show]);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <Title resource={resource} link />
      </DialogTitle>
      <DialogContent>
        {calendar && (
          <CalendarRowFields subject={subject} calendar={calendar} />
        )}
        <AllProps
          editable
          columns
          labelByName
          resource={resource}
          except={repeatProp ? [...EXCLUDED_PROPS, repeatProp] : EXCLUDED_PROPS}
        />
      </DialogContent>
    </Dialog>
  );
}
