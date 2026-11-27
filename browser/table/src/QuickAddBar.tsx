import {
  useLayoutEffect,
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
  const pending = useRef(false);
  const queued = useRef<
    {
      value: string;
      create: TableQuickAddBarProps['create'];
      onError?: TableQuickAddBarProps['onError'];
    }[]
  >([]);
  const currentOnCreated = useRef(onCreated);
  const ready = !field || typed.trim() !== '';

  useLayoutEffect(() => {
    currentOnCreated.current = onCreated;

    return () => {
      currentOnCreated.current = undefined;
    };
  }, [onCreated]);

  const drain = async () => {
    pending.current = true;
    setBusy(true);

    try {
      for (
        let request = queued.current.shift();
        request;
        request = queued.current.shift()
      ) {
        try {
          try {
            await request.create(request.value);
          } catch (error) {
            request.onError?.(error);
            continue;
          }

          currentOnCreated.current?.();
        } catch (error) {
          console.error('Quick-add notification failed', error);
        }
      }
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const add = () => {
    if (!ready) return;
    queued.current.push({ value: typed.trim(), create, onError });
    setTyped('');

    if (!pending.current) void drain();
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
