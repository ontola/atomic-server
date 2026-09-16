import { urls, useResource, useString, type Core } from '@tomic/react';

import { styled } from 'styled-components';
import Markdown from '../../../components/datatypes/Markdown';
import { InlineDatatype } from '../InlineDatatype';
import { ErrorLook } from '../../../components/ErrorLook';
import { CARD_CONTAINER } from '../../../helpers/containers';
import { dataTypeIconMap } from '../../../helpers/iconMap';
import { Row } from '../../../components/Row';

import type { JSX } from 'react';

interface PropertyLineReadProps {
  subject: string;
}

export function PropertyLineRead({
  subject,
}: PropertyLineReadProps): JSX.Element {
  const resource = useResource<Core.Property>(subject);
  const [description] = useString(resource, urls.properties.description);
  const Icon = dataTypeIconMap.get(resource.props.datatype);

  if (resource.error) {
    return (
      <tr>
        <ErrorLook>Property does not exist anymore</ErrorLook>
      </tr>
    );
  }

  return (
    <SubGrid>
      <Row center gap='1ch'>
        {Icon && <Icon />}
        <PropTitle>{resource.title}</PropTitle>
      </Row>
      <DatatypeSlot>
        <InlineDatatype resource={resource} />
      </DatatypeSlot>
      <MarkdownWrapper>
        <Markdown text={description ?? ''} />
      </MarkdownWrapper>
    </SubGrid>
  );
}

const SubGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 1rem;
  padding: var(--space-3);
  border-radius: var(--radius-md);

  @container ${CARD_CONTAINER} (inline-size < 400px) {
    grid-template-columns: 1fr;
  }

  &:nth-child(even) {
    background-color: var(--color-bg-subtle);
  }

  & svg {
    fill: var(--color-text-subtle);
  }
`;

const MarkdownWrapper = styled.span`
  @container ${CARD_CONTAINER} (inline-size > 400px) {
    grid-column: 1 / 3;
  }

  color: var(--color-text-subtle);
  padding-bottom: 0.5rem;
`;

const PropTitle = styled.span`
  font-weight: bold;
`;

const DatatypeSlot = styled.span`
  @container ${CARD_CONTAINER} (inline-size > 400px) {
    justify-self: end;
  }
`;
