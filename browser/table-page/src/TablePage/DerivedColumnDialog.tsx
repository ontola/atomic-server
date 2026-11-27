import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import { Datatype, useResource, useTitle, type Property } from '@tomic/react';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '@tomic/resource-ui/components/Dialog/index';
import { Button } from '@tomic/ui/components/Button';
import { ErrorChip } from '@tomic/resource-ui/components/forms/ErrorChip';
import { useDialogSave } from './helpers/useDialogSave.js';
import Field from '@tomic/resource-ui/components/forms/Field';
import {
  InputStyled,
  InputWrapper,
} from '@tomic/ui/components/forms/InputStyles';
import {
  bindFormula,
  columnSlugs,
  inferValueKind,
  isFormulaProperty,
  type DerivedColumnSpec,
  type DerivedValueKind,
} from './derivedColumns.js';
import { useFormulaReady, validateFormula } from './formulaEngine.js';

interface DerivedColumnDialogProps {
  open: boolean;
  bindShow: React.Dispatch<boolean>;
  /** Every property of the row class — the columns a formula can read. */
  classProperties: Property[];
  /** The spec being edited. Absent = creating a new column. */
  editing?: DerivedColumnSpec;
  onSave: (spec: DerivedColumnSpec) => void | Promise<void>;
}

/**
 * Create or edit a computed column: a name and one formula. Columns are named in
 * the formula by the slug of their name (`Last watered` is `last_watered`).
 */
export function DerivedColumnDialog({
  open,
  bindShow,
  classProperties,
  editing,
  onSave,
}: DerivedColumnDialogProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [formula, setFormula] = useState('');
  const [valueKind, setValueKind] = useState<DerivedValueKind>();
  const [dialogProps, show, hide] = useDialog({ bindShow });
  const { busy, error, clearError, submit, cancel } = useDialogSave(hide);
  const [draftId, setDraftId] = useState('');
  const ready = useFormulaReady();
  /** Clicking one fills in the name and the formula; the column names are placeholders to edit. */
  const examples: Array<{
    title: string;
    formula: string;
    valueKind?: DerivedValueKind;
  }> = [
    {
      title: 'Live duration',
      formula: 'coalesce(end, now()) - start',
      valueKind: 'duration',
    },
    { title: 'Time between', formula: 'end - start', valueKind: 'duration' },
    {
      title: 'Days since',
      formula: 'days(now() - last_contact)',
      valueKind: 'days',
    },
    { title: 'Total', formula: 'quantity * price' },
    {
      title: 'Next due',
      formula: 'addDays(last_done, every_days)',
      valueKind: 'date',
    },
    {
      title: 'Days until next birthday',
      formula: 'daysUntilAnniversary(birthday)',
    },
    {
      title: 'Birthday soon',
      formula: 'daysUntilAnniversary(birthday) <= 14',
      valueKind: 'boolean',
    },
  ];

  const slugs = columnSlugs(
    classProperties
      .filter(isFormulaProperty)
      .map(property => [property.shortname, property.subject]),
  );

  // Reset to the spec being edited (or a fresh one) every time it opens, so a
  // cancelled edit doesn't leak into the next one.
  useEffect(() => {
    if (!open) {
      return;
    }

    setDraftId(editing?.id ?? crypto.randomUUID());
    clearError();
    setLabel(editing?.label ?? '');
    // A column stored with generated names (`v0`) is shown by its columns' slugs.
    const slugOf = Object.fromEntries(
      Object.entries(slugs).map(([slug, subject]) => [subject, slug]),
    );
    setFormula(
      (editing?.formula ?? '').replace(
        /\b[A-Za-z_]\w*\b/g,
        name => slugOf[editing?.vars[name] ?? ''] ?? name,
      ),
    );
    setValueKind(editing?.valueKind);
    show();
  }, [open]);

  const { vars, unknown } = bindFormula(formula, slugs);
  const [[missing, suggestion] = []] = unknown;
  const readsInstants = Object.values(vars).every(subject =>
    [Datatype.TIMESTAMP, Datatype.DATE].includes(
      classProperties.find(p => p.subject === subject)?.datatype as Datatype,
    ),
  );
  const shownAs =
    inferValueKind(formula, readsInstants && Object.keys(vars).length > 0) ??
    valueKind;

  const problem = missing
    ? `There is no column "${missing}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`
    : ready &&
      formula.trim() &&
      validateFormula({ kind: 'formula', formula, vars });
  const valid =
    ready && formula.trim() !== '' && label.trim() !== '' && problem === null;

  // Nothing in the DOM while closed. Every derived column's heading mounts one
  // of these, and each renders a form — so a closed one must not be there at
  // all. `open` only flips false once the close animation has finished
  // (`bindShow`), so this doesn't cut it short.
  if (!open) {
    return <></>;
  }

  return (
    <Dialog
      {...dialogProps}
      aria-busy={busy}
      disableLightDismiss={busy}
      onClose={cancel}
    >
      <DialogTitle>
        <h1>{editing ? 'Edit computed column' : 'New computed column'}</h1>
      </DialogTitle>
      <DialogContent inert={busy}>
        <Field label='Name'>
          <InputWrapper>
            <InputStyled
              value={label}
              data-testid='derived-label'
              placeholder='Duration'
              onChange={e => setLabel(e.currentTarget.value)}
            />
          </InputWrapper>
        </Field>
        <Field
          label='Formula'
          helper={`Combine columns with + - * / and functions: now(), coalesce(a, b), days(ms), addDays(date, n), daysUntilAnniversary(date), min, max, if(test, a, b). Dates are milliseconds, a missing value leaves the cell empty, and 1/2 is 0 (write 1.0/2). Columns you can use: ${
            Object.keys(slugs).join(', ') || 'none yet'
          }.`}
          helperAlwaysVisible
          error={problem ? new Error(problem) : undefined}
        >
          <InputWrapper>
            <InputStyled
              value={formula}
              data-testid='derived-formula'
              placeholder='coalesce(end, now()) - start'
              spellCheck={false}
              onChange={e => setFormula(e.currentTarget.value)}
            />
          </InputWrapper>
        </Field>
        <Examples>
          {examples.map(example => (
            <Button
              key={example.title}
              subtle
              type='button'
              data-testid='derived-example'
              onClick={() => {
                setFormula(example.formula);
                setValueKind(example.valueKind);
                setLabel(current => current || example.title);
              }}
            >
              {example.title}
            </Button>
          ))}
        </Examples>
        {error && <ErrorChip role='alert'>{error}</ErrorChip>}
      </DialogContent>
      <DialogActions>
        <Button subtle disabled={busy} onClick={cancel}>
          Cancel
        </Button>
        <Button
          disabled={busy || !valid}
          data-testid='derived-save'
          onClick={() =>
            submit(() =>
              onSave({
                // An edited column keeps its id, so its stored width and position
                // survive.
                id: draftId,
                label: label.trim(),
                formula,
                vars,
                ...(editing?.width ? { width: editing.width } : {}),
                ...(shownAs ? { valueKind: shownAs } : {}),
              }),
            )
          }
        >
          {editing ? 'Save' : 'Add column'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** Labels a column by its human title, the way the column menus do. */
export function PropertyOption({
  property,
}: {
  property: Property;
}): JSX.Element {
  const resource = useResource(property.subject);
  const [title] = useTitle(resource);

  return (
    <option value={property.subject}>{title || property.shortname}</option>
  );
}

const Examples = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;
