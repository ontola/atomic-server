import {
  useRef,
  useState,
  type ComponentType,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { styled } from 'styled-components';
import { FaPlus } from 'react-icons/fa6';
import { InputStyled } from '@tomic/ui/components/forms/InputStyles';
import { Button as SharedButton } from '@tomic/ui/components/Button';

export interface TableQuickAddButtonProps {
  children?: ReactNode;
  disabled?: boolean;
  type?: 'button';
  onClick: () => void;
  'data-testid'?: string;
}
export interface TableQuickAddBarProps {
  label: string;
  field?: boolean;
  placeholder?: string;
  create: (value: string) => Promise<unknown>;
  onCreated?: () => void;
  onError?: (error: unknown) => void;
  Field?: ComponentType<InputHTMLAttributes<HTMLInputElement>>;
  Button?: ComponentType<TableQuickAddButtonProps>;
}
/** Existing quick-add input and local serial queue; backend operations stay with the host. */
export function TableQuickAddBar({
  label,
  field,
  placeholder,
  create,
  onCreated,
  onError,
  Field = DefaultField,
  Button = SharedButton,
}: TableQuickAddBarProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const queued = useRef<string[]>([]);
  const ready = !field || typed.trim() !== '';

  const submit = (value: string) => {
    setBusy(true);
    void create(value)
      .then(() => onCreated?.())
      .catch(error => onError?.(error))
      .finally(() => {
        const next = queued.current.shift();

        if (next === undefined) {
          setBusy(false);

          return;
        }

        submit(next);
      });
  };

  const add = () => {
    if (!ready) return;
    const value = typed.trim();
    setTyped('');

    if (busy) {
      queued.current.push(value);

      return;
    }

    submit(value);
  };

  return (
    <Bar>
      {field && (
        <Field
          placeholder={placeholder ?? label}
          data-testid='quick-add-input'
          value={typed}
          onChange={event => setTyped(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
      )}
      <Button
        data-testid='quick-add-button'
        disabled={!ready || busy}
        onClick={add}
      >
        <FaPlus /> {label}
      </Button>
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
const DefaultField = styled(InputStyled)`
  flex: 1;
  min-width: 12rem;
  max-width: 30rem;
`;
