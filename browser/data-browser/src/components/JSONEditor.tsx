import { lazy, Suspense } from 'react';
import type { JSONEditorProps } from '../chunks/CodeEditor/AsyncJSONEditor';
import { styled } from 'styled-components';

const AsyncJSONEditor = lazy(
  () => import('../chunks/CodeEditor/AsyncJSONEditor'),
);

export const JSONEditor: React.FC<JSONEditorProps> = props => {
  return (
    <Suspense fallback={<Loader />}>
      <AsyncJSONEditor {...props} />
    </Suspense>
  );
};

const Loader = styled.div`
  background-color: var(--color-bg);
  border: 1px solid var(--color-border);
  height: 150px;
`;
