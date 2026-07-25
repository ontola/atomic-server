import { styled } from 'styled-components';
import { CodeBlock } from './CodeBlock';

/** Enough to recognise which secret this is, far too little to use it. */
const DEFAULT_VISIBLE_CHARS = 6;

export interface SecretCodeBlockProps {
  content: string;
  className?: string;
  onCopy?: () => void;
  /** Characters left legible at the start. */
  visibleChars?: number;
}

/**
 * A secret shown on screen: the first few characters stay legible so you can
 * tell what you're looking at, the rest is blurred until you hover or focus
 * it. Copying is unaffected — the button reads the full value.
 *
 * Splits by *character count*, deliberately. The previous version split on
 * newlines, and `Agent.buildSecret` returns single-line base64 — so the
 * "blurred" span was always empty and the whole secret rendered in the clear
 * (on the onboarding screen, over someone's shoulder, in screen shares).
 */
export function SecretCodeBlock({
  content,
  className,
  onCopy,
  visibleChars = DEFAULT_VISIBLE_CHARS,
}: SecretCodeBlockProps) {
  return (
    <Styled
      className={className}
      wordWrap
      content={content}
      onCopy={onCopy}
      renderContent={value => {
        const raw = value ?? '';
        const head = raw.slice(0, visibleChars);
        const rest = raw.slice(visibleChars);

        return (
          <>
            <span key='head' data-code-text-first>
              {head}
            </span>
            {rest ? (
              <span key='rest' data-code-text-rest>
                {rest}
              </span>
            ) : null}
          </>
        );
      }}
    />
  );
}

const Styled = styled(CodeBlock)`
  word-break: break-word;

  [data-code-text-rest] {
    filter: blur(6px);
    user-select: none;
  }

  &:hover [data-code-text-rest],
  &:focus-within [data-code-text-rest] {
    filter: none;
    user-select: text;
  }

  & button {
    top: ${p => p.theme.size(1)};
    right: ${p => p.theme.size(1)};
  }
`;
