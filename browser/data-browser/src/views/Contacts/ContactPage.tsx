import type { JSX } from 'react';
import { styled } from 'styled-components';
import {
  core,
  dataBrowser,
  useCanWrite,
  useString,
  type DataBrowser,
} from '@tomic/react';
import { FaPencil } from 'react-icons/fa6';
import type { ResourcePageProps } from '../ResourcePage';
import { EditableTitle } from '../../components/EditableTitle';
import { ContainerNarrow } from '../../components/Containers';
import { Column, Row } from '../../components/Row';
import { Button } from '../../components/Button';
import AllProps from '../../components/AllProps';
import { ValueForm } from '../../components/forms/ValueForm';
import { ResourceInline } from '../ResourceInline';
import { ResourceCoverImage } from '../../components/ResourceDecorations';
import { defaultHiddenProps } from '../ResourcePageDefault';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { editURL } from '../../helpers/navigation';
import { ResourceGlyph } from '../../components/ResourceGlyph';

const contactHiddenProps = [
  ...defaultHiddenProps,
  dataBrowser.properties.givenName,
  dataBrowser.properties.familyName,
  dataBrowser.properties.organization,
  dataBrowser.properties.jobTitle,
  dataBrowser.properties.email,
  dataBrowser.properties.telephone,
  dataBrowser.properties.contactAgent,
  dataBrowser.properties.website,
  dataBrowser.properties.vcardUid,
];

export function ContactPage({
  resource,
}: ResourcePageProps<DataBrowser.Contact>): JSX.Element {
  const canEdit = useCanWrite(resource);
  const navigate = useNavigateWithTransition();
  const [email] = useString(resource, dataBrowser.properties.email);
  const [telephone] = useString(resource, dataBrowser.properties.telephone);
  const [organization] = useString(
    resource,
    dataBrowser.properties.organization,
  );
  const [jobTitle] = useString(resource, dataBrowser.properties.jobTitle);
  const [givenName] = useString(resource, dataBrowser.properties.givenName);
  const [familyName] = useString(resource, dataBrowser.properties.familyName);
  const [website] = useString(resource, dataBrowser.properties.website);
  const [agent] = useString(resource, dataBrowser.properties.contactAgent);

  const subtitle = [jobTitle, organization].filter(Boolean).join(' · ');
  const formalName = [givenName, familyName].filter(Boolean).join(' ');

  return (
    <>
      <ResourceCoverImage resource={resource} />
      <ContainerNarrow>
        <Column gap='1.25rem'>
          <Header>
            <Identity>
              <Avatar>
                <ResourceGlyph resource={resource} />
              </Avatar>
              <Column gap='0.25rem'>
                <EditableTitle resource={resource} withDecorations />
                {subtitle && <Subtitle>{subtitle}</Subtitle>}
                {formalName && formalName !== resource.title && (
                  <Subtitle>{formalName}</Subtitle>
                )}
              </Column>
            </Identity>
            {canEdit && (
              <Button
                ghost
                onClick={() => navigate(editURL(resource.subject))}
              >
                <FaPencil aria-hidden /> Edit
              </Button>
            )}
          </Header>

          <Reachability>
            {email && (
              <Fact>
                <Label>Email</Label>
                <a href={`mailto:${email}`}>{email}</a>
              </Fact>
            )}
            {telephone && (
              <Fact>
                <Label>Phone</Label>
                <a href={`tel:${telephone}`}>{telephone}</a>
              </Fact>
            )}
            {website && (
              <Fact>
                <Label>Website</Label>
                <a href={website} target='_blank' rel='noreferrer'>
                  {website}
                </a>
              </Fact>
            )}
            {agent && (
              <Fact>
                <Label>Atomic Agent</Label>
                <ResourceInline subject={agent} />
              </Fact>
            )}
            {!email && !telephone && !website && !agent && (
              <Muted>No contact details yet — use Edit to add them.</Muted>
            )}
          </Reachability>

          <ValueForm
            resource={resource}
            propertyURL={core.properties.description}
          />

          <AllProps
            resource={resource}
            except={contactHiddenProps}
            editable
            columns
          />
        </Column>
      </ContainerNarrow>
    </>
  );
}

const Header = styled(Row)`
  align-items: flex-start;
  justify-content: space-between;
  gap: ${p => p.theme.size(3)};
`;

const Identity = styled(Row)`
  align-items: center;
  gap: ${p => p.theme.size(3)};
  min-width: 0;
`;

const Avatar = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 50%;
  background: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.main};
  font-size: 1.5rem;
  flex-shrink: 0;
`;

const Subtitle = styled.div`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
`;

const Reachability = styled.div`
  display: grid;
  gap: ${p => p.theme.size(2)};
  padding: ${p => p.theme.size(3)};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const Fact = styled.div`
  display: grid;
  grid-template-columns: 8rem 1fr;
  gap: ${p => p.theme.size(2)};
  align-items: center;

  a {
    color: ${p => p.theme.colors.main};
    overflow: hidden;
    text-overflow: ellipsis;
  }
`;

const Label = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
  font-weight: 600;
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
`;
