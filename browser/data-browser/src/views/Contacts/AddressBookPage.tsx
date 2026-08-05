import { useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  core,
  dataBrowser,
  unknownSubject,
  useCollection,
  useMemberFromCollection,
  useString,
  useTitle,
  type Collection,
  type DataBrowser,
} from '@tomic/react';
import { FaFileImport, FaPlus, FaMagnifyingGlass } from 'react-icons/fa6';
import type { ResourcePageProps } from '../ResourcePage';
import { EditableTitle } from '../../components/EditableTitle';
import { ContainerWide } from '../../components/Containers';
import { Column, Row } from '../../components/Row';
import { Button } from '../../components/Button';
import { SkeletonButton } from '../../components/SkeletonButton';
import { InputStyled, InputWrapper } from '../../components/forms/InputStyles';
import { useNewResourceUI } from '../../components/forms/NewForm/useNewResourceUI';
import { LoaderInline } from '../../components/Loader';
import { ContactRow } from './ContactRow';
import { ImportVCardDialog } from './ImportVCardDialog';

export function AddressBookPage({
  resource,
}: ResourcePageProps<DataBrowser.AddressBook>): JSX.Element {
  const [query, setQuery] = useState('');
  const [showImport, setShowImport] = useState(false);
  const showNewResourceUI = useNewResourceUI();

  const { collection, ready, invalidateCollection, mapAll } = useCollection(
    {
      property: core.properties.parent,
      value: resource.subject,
      filters: [
        {
          property: core.properties.isA,
          value: dataBrowser.classes.contact,
        },
      ],
      sort_by: core.properties.name,
    },
    { pageSize: 200 },
  );

  return (
    <ContainerWide>
      <Column gap='1.5rem'>
        <Header>
          <EditableTitle resource={resource} />
          <Row gap='0.5rem' center>
            <Button subtle onClick={() => setShowImport(true)}>
              <FaFileImport />
              Import vCard
            </Button>
            <Button
              onClick={() =>
                showNewResourceUI(dataBrowser.classes.contact, resource.subject)
              }
            >
              <FaPlus />
              New Contact
            </Button>
          </Row>
        </Header>

        <SearchRow>
          <InputWrapper hasPrefix>
            <SearchIcon aria-hidden>
              <FaMagnifyingGlass />
            </SearchIcon>
            <InputStyled
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder='Filter contacts…'
              aria-label='Filter contacts'
            />
          </InputWrapper>
        </SearchRow>

        {!ready && <LoaderInline>Loading contacts…</LoaderInline>}

        {ready && collection.totalMembers === 0 && (
          <Empty>
            <p>
              No contacts yet. Create one or import a `.vcf` export from Google,
              iCloud, or Microsoft.
            </p>
            <Row gap='0.5rem'>
              <SkeletonButton
                onClick={() =>
                  showNewResourceUI(
                    dataBrowser.classes.contact,
                    resource.subject,
                  )
                }
              >
                <FaPlus /> New Contact
              </SkeletonButton>
              <SkeletonButton onClick={() => setShowImport(true)}>
                <FaFileImport /> Import vCard
              </SkeletonButton>
            </Row>
          </Empty>
        )}

        {ready && collection.totalMembers > 0 && (
          <List>
            {mapAll(({ index, collection: col }) => (
              <FilteredContactRow
                key={index}
                collection={col}
                index={index}
                query={query}
              />
            ))}
          </List>
        )}
      </Column>

      <ImportVCardDialog
        addressBook={resource.subject}
        show={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => {
          void invalidateCollection();
        }}
      />
    </ContainerWide>
  );
}

function FilteredContactRow({
  collection,
  index,
  query,
}: {
  collection: Collection;
  index: number;
  query: string;
}): JSX.Element | null {
  const resource = useMemberFromCollection(collection, index);
  const [title] = useTitle(resource);
  const [email] = useString(resource, dataBrowser.properties.email);
  const [telephone] = useString(resource, dataBrowser.properties.telephone);
  const [organization] = useString(
    resource,
    dataBrowser.properties.organization,
  );

  if (
    resource.loading ||
    !resource.subject ||
    resource.subject === unknownSubject
  ) {
    return null;
  }

  const q = query.trim().toLowerCase();

  if (
    q &&
    ![title, email, telephone, organization]
      .filter(Boolean)
      .some(v => v!.toLowerCase().includes(q))
  ) {
    return null;
  }

  return <ContactRow subject={resource.subject} />;
}

const Header = styled(Row)`
  align-items: flex-start;
  justify-content: space-between;
  gap: ${p => p.theme.size(3)};
  flex-wrap: wrap;
`;

const SearchRow = styled.div`
  max-width: 28rem;
`;

const SearchIcon = styled.span`
  display: flex;
  color: ${p => p.theme.colors.textLight};
`;

const List = styled.div`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  overflow: hidden;

  > * + * {
    border-top: 1px solid ${p => p.theme.colors.bg2};
  }
`;

const Empty = styled(Column)`
  align-items: flex-start;
  gap: ${p => p.theme.size(3)};
  padding: ${p => p.theme.size(6)} 0;
  color: ${p => p.theme.colors.textLight};
`;
