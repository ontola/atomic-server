import {
  useEffect,
  useEffectEvent,
  useId,
  useState,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import type {
  DerivedColumnSpec,
  DerivedValueKind,
} from './views/configuration.js';
import {
  bindTableFormula,
  tableFormulaColumnSlugs,
  inferTableDerivedValueKind,
} from './views/formulaModel.js';
import type { TableQuickAddButtonProps } from './QuickAddBar.js';
import { tableTheme } from './theme.js';

export interface TableFormulaColumn {
  key: string;
  label: string;
  instant?: boolean;
}
export interface TableFormulaExample {
  title: string;
  formula: string;
  valueKind?: DerivedValueKind;
}
export interface TableDerivedColumnFieldsProps {
  initial?: DerivedColumnSpec;
  columns: readonly TableFormulaColumn[];
  ready: boolean;
  disabled?: boolean;
  examples?: readonly TableFormulaExample[];
  validate: (expression: {
    kind: 'formula';
    formula: string;
    vars: Record<string, string>;
  }) => string | null | undefined;
  onChange: (draft: DerivedColumnSpec, valid: boolean) => void;
  helper?: (identifiers: readonly string[]) => ReactNode;
  Input?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  ExampleButton?: ComponentType<TableQuickAddButtonProps>;
  messages?: Partial<{
    name: string;
    formula: string;
    namePlaceholder: string;
    formulaPlaceholder: string;
    unknown: (name: string, suggestion?: string) => string;
  }>;
}
/** Actual computed-column draft fields. Evaluation stays with the backend's
 * validator; identifier binding, display inference and local edits are shared. */
export function TableDerivedColumnFields({
  initial,
  columns,
  ready,
  disabled,
  examples = [],
  validate,
  onChange,
  helper,
  Input = DefaultInput,
  ExampleButton = DefaultButton,
  messages,
}: TableDerivedColumnFieldsProps) {
  const id = useId();
  const slugs = tableFormulaColumnSlugs(
    columns.map(column => [column.label, column.key]),
  );
  const [identity] = useState(() => ({
    id: initial?.id ?? '',
    width: initial?.width,
  }));
  const [label, setLabel] = useState(initial?.label ?? '');
  const [formula, setFormula] = useState(() => {
    const slugOf = Object.fromEntries(
      Object.entries(slugs).map(([slug, key]) => [key, slug]),
    );

    return (initial?.formula ?? '').replace(
      /\b[A-Za-z_]\w*\b/g,
      name => slugOf[initial?.vars[name] ?? ''] ?? name,
    );
  });
  const [valueKind, setValueKind] = useState(initial?.valueKind);
  const { vars, unknown } = bindTableFormula(formula, slugs);
  const [[missing, suggestion] = []] = unknown;
  const readsInstants = Object.values(vars).every(
    key => columns.find(column => column.key === key)?.instant,
  );
  const shownAs =
    inferTableDerivedValueKind(
      formula,
      readsInstants && Object.keys(vars).length > 0,
    ) ?? valueKind;
  const text = {
    name: 'Name',
    formula: 'Formula',
    namePlaceholder: 'Duration',
    formulaPlaceholder: 'coalesce(end, now()) - start',
    unknown: unknownColumn,
    ...messages,
  };
  const problem = missing
    ? text.unknown(missing, suggestion)
    : ready && formula.trim()
      ? validate({ kind: 'formula', formula, vars })
      : null;
  const draft: DerivedColumnSpec = {
    id: identity.id,
    label: label.trim(),
    formula,
    vars,
    ...(identity.width ? { width: identity.width } : {}),
    ...(shownAs ? { valueKind: shownAs } : {}),
  };
  const valid =
    !disabled &&
    ready &&
    !!formula.trim() &&
    !!label.trim() &&
    problem === null;
  const key = JSON.stringify(draft);
  const notify = useEffectEvent(() => onChange(draft, valid));
  useEffect(() => {
    notify();
  }, [key, valid]);

  return (
    <Fields disabled={disabled}>
      <Field>
        <label htmlFor={`${id}-name`}>{text.name}</label>
        <Input
          id={`${id}-name`}
          data-testid='derived-label'
          value={label}
          placeholder={text.namePlaceholder}
          onChange={event => setLabel(event.target.value)}
        />
      </Field>
      <Field>
        <label htmlFor={`${id}-formula`}>{text.formula}</label>
        <Input
          id={`${id}-formula`}
          data-testid='derived-formula'
          value={formula}
          placeholder={text.formulaPlaceholder}
          spellCheck={false}
          aria-invalid={!!problem}
          aria-describedby={`${id}-help`}
          onChange={event => setFormula(event.target.value)}
        />
        {problem && <Hint role='alert'>{problem}</Hint>}
        <Hint id={`${id}-help`}>{helper?.(Object.keys(slugs))}</Hint>
      </Field>
      <Examples>
        {examples.map(example => (
          <ExampleButton
            key={example.title}
            type='button'
            data-testid='derived-example'
            onClick={() => {
              setFormula(example.formula);
              setValueKind(example.valueKind);
              setLabel(current => current || example.title);
            }}
          >
            {example.title}
          </ExampleButton>
        ))}
      </Examples>
    </Fields>
  );
}

function unknownColumn(name: string, suggestion?: string) {
  return `There is no column "${name}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`;
}

const Fields = styled.fieldset`
  display: flex;
  flex-direction: column;
  gap: 1rem;
  border: none;
  padding: 0;
  margin: 0;
`;
const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
`;
const Hint = styled.span`
  color: ${p => tableTheme(p.theme).colors.textLight};
  font-size: 0.85rem;
`;
const Examples = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
`;
const DefaultInput = styled.input`
  padding: 0.4rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  color: ${p => tableTheme(p.theme).colors.text};
  background: ${p => tableTheme(p.theme).colors.bg};
`;
const DefaultButton = styled.button`
  font: inherit;
  cursor: pointer;
`;
