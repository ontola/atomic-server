import type { JSX } from 'react';
import { styled } from 'styled-components';
import {
  dataBrowser,
  useResource,
  useString,
  useTitle,
} from '@tomic/react';
import { AtomicLink } from '../../components/AtomicLink';
import { ResourceInline } from '../ResourceInline';
import { ResourceGlyph } from '../../components/ResourceGlyph';

type ContactRowProps = {
  subject: string;
};

export function ContactRow({ subject }: ContactRowProps): JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  const [email] = useString(resource, dataBrowser.properties.email);
  const [telephone] = useString(resource, dataBrowser.properties.telephone);
  const [organization] = useString(
    resource,
    dataBrowser.properties.organization,
  );
  const [agent] = useString(resource, dataBrowser.properties.contactAgent);

  return (
    <RowLink subject={subject}>
      <GlyphWrap>
        <ResourceGlyph resource={resource} />
      </GlyphWrap>
      <Main>
        <Name>{title}</Name>
        {(organization || email || telephone) && (
          <Meta>
            {[organization, email, telephone].filter(Boolean).join(' · ')}
          </Meta>
        )}
      </Main>
      {agent && (
        <AgentWrap
          onClick={e => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <ResourceInline subject={agent} />
        </AgentWrap>
      )}
    </RowLink>
  );
}

const RowLink = styled(AtomicLink)`
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: ${p => p.theme.size(3)};
  padding: ${p => p.theme.size(3)} ${p => p.theme.size(2)};
  border-radius: ${p => p.theme.radius};
  text-decoration: none;
  color: inherit;

  &:hover {
    background: ${p => p.theme.colors.bg1};
  }
`;

const GlyphWrap = styled.div`
  display: flex;
  font-size: 1.25rem;
  color: ${p => p.theme.colors.textLight};
`;

const Main = styled.div`
  min-width: 0;
`;

const Name = styled.div`
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.div`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const AgentWrap = styled.div`
  font-size: 0.85rem;
`;
