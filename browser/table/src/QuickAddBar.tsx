import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { FaPlus } from 'react-icons/fa6';
import { createTableQuickAddQueue } from './quickAddQueue.js';
import { tableTheme } from './theme.js';

export interface TableQuickAddButtonProps {
  children?: ReactNode;
  disabled?: boolean;
  type?: 'button';
  onClick: () => void;
  'data-testid'?: string;
}
export interface TableQuickAddBarProps {
  scope: string;
  label: string;
  field?: boolean;
  placeholder?: string;
  disabled?: boolean;
  create: (value: string) => Promise<unknown>;
  onCreated?: () => void;
  onError?: (error: unknown) => void;
  Field?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Button?: ComponentType<TableQuickAddButtonProps>;
}
/** Actual quick-add input/button and serial queue, shared by backend adapters. */
export function TableQuickAddBar(props: TableQuickAddBarProps) {
  return <QuickAddSession key={props.scope} {...props} />;
}

function QuickAddSession({
  label,
  field,
  placeholder,
  disabled,
  create,
  onCreated,
  onError,
  Field = DefaultField,
  Button = DefaultButton,
}: TableQuickAddBarProps) {
  const [typed, setTyped] = useState('');
  const queue = useMemo(() => createTableQuickAddQueue(), []);
  const state = useSyncExternalStore(
    queue.subscribe,
    queue.getSnapshot,
    queue.getSnapshot,
  );
  useEffect(() => {
    queue.activate();

    return () => queue.deactivate();
  }, [queue]);
  const ready = !disabled && (!field || !!typed.trim());

  const submit = () => {
    if (!ready) return;
    queue.enqueue({ value: typed.trim(), create, onCreated, onError });
    setTyped('');
  };

  return (
    <Bar aria-busy={state.pending > 0}>
      {field && (
        <Field
          aria-label={placeholder ?? label}
          placeholder={placeholder ?? label}
          data-testid='quick-add-input'
          disabled={disabled}
          value={typed}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
        />
      )}
      <Button
        type='button'
        data-testid='quick-add-button'
        disabled={!ready || state.pending > 0}
        onClick={submit}
      >
        <FaPlus /> {label}
      </Button>
      {state.failures.map((failure, index) => (
        <p key={index} role='alert'>
          {failure.value
            ? `Could not add “${failure.value}”: `
            : 'Could not add row: '}
          {String(failure.error)}
        </p>
      ))}
    </Bar>
  );
}

const Bar = styled.div`
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding-block: 0.5rem;
  flex-wrap: wrap;
`;
const DefaultField = styled.input`
  flex: 1;
  min-width: 12rem;
  max-width: 30rem;
  border: 1px solid ${p => tableTheme(p.theme).colors.bg2};
  border-radius: ${p => tableTheme(p.theme).radius};
  padding: 0.4rem 0.6rem;
  color: ${p => tableTheme(p.theme).colors.text};
  background: ${p => tableTheme(p.theme).colors.bg};
`;
const DefaultButton = styled.button`
  font: inherit;
  padding: 0.4rem 0.6rem;
  cursor: pointer;
  &:disabled {
    opacity: 0.5;
    cursor: default;
  }
`;
