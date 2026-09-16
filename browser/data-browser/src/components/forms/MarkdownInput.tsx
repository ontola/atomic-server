import { lazy, Suspense } from 'react';
import type { AsyncMarkdownEditorProps } from '@chunks/RTE/AsyncMarkdownEditor';
import { styled } from 'styled-components';

const MarkdownEditor = lazy(() => import('@chunks/RTE/AsyncMarkdownEditor'));

export function MarkdownInput(
  props: AsyncMarkdownEditorProps,
): React.JSX.Element {
  return (
    <Suspense fallback={<DummyEditor />}>
      <MarkdownEditor {...props} />
    </Suspense>
  );
}

const DummyEditor = styled.div`
  background-color: var(--color-bg);
  padding: var(--space-3);
  border-radius: var(--radius-md);
  box-shadow: 0 0 0 1px var(--color-border);
  width: min(100%, 75ch);
  min-height: 10rem;
`;
