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
  type CalendarRowContext,
} from './Calendar/CalendarRowFields';

interface ExpandedRowDialogProps {
  subject: string;
  open: boolean;
  bindOpen: (open: boolean) => void;
  /** Opened from a calendar view: show the row's calendar fields (Repeat)
   * instead of their raw values. */
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
          except={
            calendar?.recurrenceProp
              ? [...EXCLUDED_PROPS, calendar.recurrenceProp.subject]
              : EXCLUDED_PROPS
          }
        />
      </DialogContent>
    </Dialog>
  );
}
