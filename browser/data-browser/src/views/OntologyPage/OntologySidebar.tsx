import { core, Resource, useArray, useResource } from '@tomic/react';

import { styled } from 'styled-components';
import { Details } from '../../components/Details';
import { FaAtom, FaCube, FaHashtag } from 'react-icons/fa6';
import { ScrollArea } from '../../components/ScrollArea';
import { toAnchorId } from '../../helpers/toAnchorId';

import type { JSX } from 'react';

interface OntologySidebarProps {
  ontology: Resource;
}

export function OntologySidebar({
  ontology,
}: OntologySidebarProps): JSX.Element {
  const [classes] = useArray(ontology, core.properties.classes);
  const [properties] = useArray(ontology, core.properties.properties);
  const [instances] = useArray(ontology, core.properties.instances);

  return (
    <Wrapper>
      <SideBarScrollArea>
        <Details
          initialState={true}
          title={
            <Title>
              <FaCube />
              Classes
            </Title>
          }
        >
          <ul>
            {classes.map(c => (
              <Item key={c} subject={c} />
            ))}
          </ul>
        </Details>
        <Details
          initialState={true}
          title={
            <Title>
              <FaHashtag />
              Properties
            </Title>
          }
        >
          <ul>
            {properties.map(c => (
              <Item key={c} subject={c} />
            ))}
          </ul>
        </Details>
        <Details
          initialState={true}
          title={
            <Title>
              <FaAtom />
              Instances
            </Title>
          }
        >
          <ul>
            {instances.map(c => (
              <Item key={c} subject={c} />
            ))}
          </ul>
        </Details>
      </SideBarScrollArea>
    </Wrapper>
  );
}

interface ItemProps {
  subject: string;
}

function Item({ subject }: ItemProps): JSX.Element {
  const resource = useResource(subject);

  return (
    <StyledLi>
      <ItemLink href={`#${toAnchorId(subject)}`} error={!!resource.error}>
        {resource.title}
      </ItemLink>
    </StyledLi>
  );
}

const Wrapper = styled.div`
  --ontology-sidebar-height: calc(100vh - var(--height-breadcrumb-bar));
  position: sticky;
  top: 0px;
  display: flex;
  flex-direction: column;
  background-color: var(--color-bg);
  height: var(--ontology-sidebar-height);
  border-left: 1px solid var(--color-border);
  min-width: 10rem;
`;

const Title = styled.b`
  display: inline-flex;
  align-items: center;
  gap: 0.8ch;
`;

const StyledLi = styled.li`
  list-style: none;
  margin-left: 0;
  width: 100%;
  margin-bottom: 0;
`;

const ItemLink = styled.a<{ error: boolean }>`
  padding-left: 1rem;
  padding-block: 0.2rem;
  border-radius: var(--radius-md);
  display: block;
  color: ${p => (p.error ? 'var(--color-alert)' : 'var(--color-text-subtle)')};
  text-decoration: none;
  width: 100%;
  &:hover,
  &:focus-visible {
    color: var(--color-text);
    background-color: var(--color-bg-subtle);
  }
  white-space: nowrap;
`;

const SideBarScrollArea = styled(ScrollArea)`
  overflow: hidden;
  padding: var(--space-3);
  padding-left: 0.5rem;
  max-height: var(--ontology-sidebar-height);
`;
