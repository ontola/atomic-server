import { Resource } from '@tomic/react';
import { lazy, Suspense, type JSX } from 'react';
import { styled } from 'styled-components';

const OntologyGraph = lazy(
  () => import('../../chunks/GraphViewer/OntologyGraph'),
);

interface GraphProps {
  ontology: Resource;
}

export function Graph({ ontology }: GraphProps): JSX.Element {
  return (
    <GraphWrapper>
      <Suspense fallback='loading...'>
        <OntologyGraph ontology={ontology} />
      </Suspense>
    </GraphWrapper>
  );
}

const GraphWrapper = styled.div`
  position: var(--ontology-graph-position);
  display: grid;
  place-items: stretch;
  min-width: 0;
  background-color: var(--color-bg-subtle);
  border: 1px solid var(--color-border);
  aspect-ratio: var(--ontology-graph-ratio);
  border-radius: var(--radius-md);
  top: 1rem;
  overflow: hidden;
`;
