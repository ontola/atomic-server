import { resourceTheme } from '../../theme.js';
import { lazy, Suspense } from 'react';
import type { AsyncMarkdownEditorProps } from '../../chunks/RTE/AsyncMarkdownEditor.js';
import { styled } from 'styled-components';

const MarkdownEditor = lazy(
  () => import('../../chunks/RTE/AsyncMarkdownEditor.js'),
);

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
  background-color: ${p => resourceTheme(p.theme).colors.bg};
  padding: ${p => resourceTheme(p.theme).margin}rem;
  border-radius: ${p => resourceTheme(p.theme).radius};
  box-shadow: 0 0 0 1px ${p => resourceTheme(p.theme).colors.bg2};
  width: min(100%, 75ch);
  min-height: 10rem;
`;
