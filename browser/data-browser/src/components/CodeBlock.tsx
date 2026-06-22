import { useRef, useState, type ReactNode } from 'react';
import toast from 'react-hot-toast';
import { FaCheck, FaCopy } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Button } from './Button';
import clsx from 'clsx';

interface CodeBlockProps {
  content?: string;
  loading?: boolean;
  wordWrap?: boolean;
  className?: string;
  onCopy?: () => void;
  /** Optional custom renderer for displaying `content` (copy still uses `content`). */
  renderContent?: (content: string | undefined) => ReactNode;
}

export function CodeBlock({
  content,
  loading,
  wordWrap = false,
  className,
  onCopy,
  renderContent,
}: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const [isCopied, setIsCopied] = useState<string | undefined>(undefined);

  async function copyToClipboard() {
    const text = content || '';

    if (await writeClipboardText(text)) {
      setIsCopied(content);
      toast.success('Copied to clipboard');
      onCopy?.();

      return;
    }

    selectCodeBlockText(preRef.current);
    toast.error('Clipboard access is blocked. Select the text and copy it.');
  }

  return (
    <CodeBlockStyled
      onCopy={() => {
        onCopy?.();
        setIsCopied(content);
      }}
      ref={preRef}
      data-code-content={content}
      className={clsx({ 'word-wrap': wordWrap }, className)}
    >
      {loading ? (
        'loading...'
      ) : (
        <>
          {renderContent ? (
            renderContent(content)
          ) : (
            <span data-code-text>{content}</span>
          )}
          <Button
            subtle
            style={{
              position: 'absolute',
              bottom: 0,
              top: 0,
              margin: 0,
              right: 0,
            }}
            onClick={copyToClipboard}
            title={isCopied === content ? 'Copied!' : 'Copy to clipboard'}
            data-test='copy-response'
          >
            {isCopied === content ? <FaCheck /> : <FaCopy />}
          </Button>
        </>
      )}
    </CodeBlockStyled>
  );
}

async function writeClipboardText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);

      return true;
    } catch {
      // Fall through to the legacy path below. Browsers can expose the API
      // but still reject it on insecure origins such as local HTTP hosts.
    }
  }

  return copyWithTextarea(text);
}

function copyWithTextarea(text: string): boolean {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function selectCodeBlockText(pre: HTMLPreElement | null): void {
  if (!pre) return;

  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(pre);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

export const CodeBlockStyled = styled.pre`
  position: relative;
  background-color: ${p => p.theme.colors.bg1};
  border-radius: ${p => p.theme.radius};
  border: solid 1px ${p => p.theme.colors.bg2};
  padding: 0.3rem;
  font-family: monospace;
  width: 100%;
  overflow-x: auto;

  &.word-wrap {
    white-space: pre-wrap;
  }
`;
