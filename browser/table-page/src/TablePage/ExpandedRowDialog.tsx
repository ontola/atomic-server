import { resourceTheme } from '@tomic/resource-ui/theme';
import { commits, core, useResource, dataBrowser } from '@tomic/react';
import { useEffect, type JSX } from 'react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import AllProps from '@tomic/resource-ui/components/AllProps';
import { useTableEditorContext } from '@tomic/table';
import { Title } from '@tomic/resource-ui/components/Title';
import {
  CalendarRowFields,
  readRowRepeat,
  type CalendarRowContext,
} from './Calendar/CalendarRowFields.js';
import { useTableRowExtras } from '@tomic/resource-ui/chunks/AppPage/useRowExtras';
import { styled } from 'styled-components';

const KeptByApps = styled.details`
  margin-top: 1rem;
  color: ${p => resourceTheme(p.theme).colors.textLight};

  summary {
    cursor: pointer;
    margin-bottom: 0.5rem;
  }
`;

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
  // What the apps viewing this table keep on its rows (#1849): a sync's
  // provider id, version and baseline. Not the person's fields, so they are
  // kept out of the editable list and shown read-only, folded away.
  const table = resource.get(core.properties.parent);
  const extras = useTableRowExtras(
    typeof table === 'string' ? table : undefined,
  );
  const keptExtras = extras.filter(extra => resource.get(extra) !== undefined);
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
          except={[
            ...EXCLUDED_PROPS,
            ...extras,
            ...(repeatProp ? [repeatProp] : []),
          ]}
        />
        {keptExtras.length > 0 && (
          <KeptByApps>
            <summary>Kept by apps</summary>
            <AllProps columns resource={resource} only={keptExtras} />
          </KeptByApps>
        )}
      </DialogContent>
    </Dialog>
  );
}
