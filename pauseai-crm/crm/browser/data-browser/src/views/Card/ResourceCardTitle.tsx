import { Resource } from '@tomic/react';
import { FC, PropsWithChildren } from 'react';
import { styled } from 'styled-components';
import { AtomicLink } from '../../components/AtomicLink';
import { type ViewTransitionProps } from '../../helpers/ViewTransitionProps';
import {
  PAGE_TITLE_TRANSITION_TAG,
  transitionName,
} from '../../helpers/transitionName';
import { ResourceGlyph } from '../../components/ResourceGlyph';
import { Row } from '../../components/Row';

interface ResourceCardTitleProps {
  resource: Resource;
  alternateTitle?: string;
}

export const ResourceCardTitle: FC<
  PropsWithChildren<ResourceCardTitleProps>
> = ({ resource, children, alternateTitle }) => {
  return (
    <TitleRow center gap='1ch' justify='space-between' wrapItems>
      <Row center gap='1ch'>
        <ResourceGlyph resource={resource} />
        <AtomicLink subject={resource.subject}>
          <Title subject={resource.subject}>
            {alternateTitle ?? resource.title}
          </Title>
        </AtomicLink>
      </Row>
      {children}
    </TitleRow>
  );
};

const Title = styled.h2<ViewTransitionProps>`
  font-size: 1.4rem;
  margin: 0;
  ${props => transitionName(PAGE_TITLE_TRANSITION_TAG, props.subject)};
  white-space: nowrap;
  text-overflow: ellipsis;
`;

const TitleRow = styled(Row)`
  max-width: 100%;
  overflow: hidden;
  color: ${({ theme }) => theme.colors.textLight};

  svg {
    min-width: 1em;
  }
`;
