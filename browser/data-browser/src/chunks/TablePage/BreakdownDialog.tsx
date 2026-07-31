import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { useResource, useTitle, type Property } from '@tomic/react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@components/Dialog';
import { Button } from '@components/Button';
import Field from '@components/forms/Field';
import { BasicSelect } from '@components/forms/BasicSelect';
import {
  defaultGranularity,
  granularityApplies,
  isGroupableProperty,
  type GroupGranularity,
} from './tableAggregates';

interface BreakdownDialogProps {
  open: boolean;
  bindShow: React.Dispatch<boolean>;
  classProperties: Property[];
  groupByColumn: string | undefined;
  granularity: GroupGranularity;
  onSave: (config: {
    groupByColumn: string;
    granularity: GroupGranularity;
  }) => void;
}

/**
 * Picks the column the table's totals are broken down by — one subtotal per
 * project, per month, per status. The totals themselves are set per column in
 * the footer; this is the one thing about them that isn't per column.
 */
export function BreakdownDialog({
  open,
  bindShow,
  classProperties,
  groupByColumn,
  granularity,
  onSave,
}: BreakdownDialogProps): JSX.Element {
  const [group, setGroup] = useState('');
  const [bucket, setBucket] = useState<GroupGranularity>('day');
  const [dialogProps, show, hide] = useDialog({ bindShow });

  useEffect(() => {
    if (!open) {
      return;
    }

    setGroup(groupByColumn ?? '');
    setBucket(granularity);
    show();
  }, [open]);

  const groupable = classProperties.filter(isGroupableProperty);
  const groupProperty = classProperties.find(p => p.subject === group);

  if (!open) {
    return <></>;
  }

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h1>Break down the totals</h1>
      </DialogTitle>
      <DialogContent>
        <Explainer>
          Splits each total per distinct value of a column — per project, per
          month, per status — under the table. Computed by the server over every
          matching row, like the totals themselves.
        </Explainer>
        <Field label='Break down by'>
          <Row>
            <BasicSelect
              value={group}
              data-testid='breakdown-column'
              onChange={e => {
                const next = e.currentTarget.value;
                setGroup(next);
                setBucket(
                  defaultGranularity(
                    classProperties.find(p => p.subject === next),
                  ),
                );
              }}
            >
              <option value=''>Nothing — one total per column</option>
              {groupable.map(p => (
                <PropertyOption key={p.subject} property={p} />
              ))}
            </BasicSelect>
            {granularityApplies(groupProperty) && (
              <BasicSelect
                value={bucket}
                data-testid='breakdown-granularity'
                onChange={e =>
                  setBucket(e.currentTarget.value as GroupGranularity)
                }
              >
                <option value='day'>Per day</option>
                <option value='month'>Per month</option>
                <option value='exact'>Per exact value</option>
              </BasicSelect>
            )}
          </Row>
        </Field>
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => hide()}>
          Cancel
        </Button>
        <Button
          data-testid='breakdown-save'
          onClick={() => {
            onSave({ groupByColumn: group, granularity: bucket });
            hide();
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Labels a column by its human title, the way the column menus do. */
function PropertyOption({ property }: { property: Property }): JSX.Element {
  const resource = useResource(property.subject);
  const [title] = useTitle(resource);

  return (
    <option value={property.subject}>{title || property.shortname}</option>
  );
}

const Row = styled.div`
  display: flex;
  gap: 0.5rem;
  align-items: center;
`;

const Explainer = styled.p`
  color: ${p => p.theme.colors.textLight};
  margin-top: 0;
`;
