import { resourceTheme } from '../theme.js';
import { lazy, Suspense } from 'react';
import type { JSONEditorProps } from '../chunks/CodeEditor/AsyncJSONEditor.js';
import { styled } from 'styled-components';

const AsyncJSONEditor = lazy(
  () => import('../chunks/CodeEditor/AsyncJSONEditor.js'),
);

export const JSONEditor: React.FC<JSONEditorProps> = props => {
  return (
    <Suspense fallback={<Loader />}>
      <AsyncJSONEditor {...props} />
    </Suspense>
  );
};

const Loader = styled.div`
  background-color: ${p => resourceTheme(p.theme).colors.bg};
  border: 1px solid ${p => resourceTheme(p.theme).colors.bg2};
  height: 150px;
`;
