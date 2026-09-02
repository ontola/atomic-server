import { styled } from 'styled-components';
import {
  core,
  removeCachedSearchResults,
  unknownSubject,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import { SideBarMenuRow } from '../SideBarMenuItem';
import { Row } from '../../Row';
import { AtomicLink } from '../../AtomicLink';
import { getIconForClass } from '../../../helpers/iconMap';
import { ScrollArea } from '../../ScrollArea';
import { ErrorLook } from '../../ErrorLook';
import { useCallback, useEffect, useState, type JSX } from 'react';
import { useSettings } from '../../../helpers/AppSettings';

export function OntologiesPanel(): JSX.Element | null {
  const store = useStore();
  const [ontologies, setOntologies] = useState<string[]>([]);
  const { drive } = useSettings();

  const search = useCallback(async () => {
    removeCachedSearchResults(store);

    const result = await store.search('', {
      filters: {
        [core.properties.isA]: core.classes.ontology,
      },
      parents: drive,
    });

    return result;
  }, [store, drive]);

  useEffect(() => {
    search().then(setOntologies);

    // If the drive was just created we need to wait for search to index the new ontology. So we search again after 5 seconds.
    setTimeout(() => {
      search().then(setOntologies);
    }, 5000);
  }, [drive, search]);

  return (
    <Wrapper>
      <StyledScrollArea key={drive} type='hover'>
        {ontologies.map(subject => (
          <Item key={subject} subject={subject} />
        ))}
      </StyledScrollArea>
    </Wrapper>
  );
}

const Wrapper = styled.div`
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  padding-top: 0;
  max-height: 10rem;
  overflow: hidden;
`;

const StyledScrollArea = styled(ScrollArea)`
  height: 10rem;
  overflow-x: hidden;
`;

interface ItemProps {
  subject: string;
}

function Item({ subject }: ItemProps): JSX.Element {
  const resource = useResource(subject);
  // Reactive title — see SidebarItemTitle for the same fix rationale.
  // `resource.title` is a non-reactive getter; renames wouldn't show up
  // until something else forced a re-render.
  const [title] = useTitle(resource);

  const Icon = getIconForClass(core.classes.ontology);

  if (resource.loading) {
    return <div>loading</div>;
  }

  if (resource.error || resource.subject === unknownSubject) {
    return (
      <SideBarMenuRow>
        <ErrorLook>Invalid Resource</ErrorLook>
      </SideBarMenuRow>
    );
  }

  return (
    <StyledLink subject={subject} clean>
      <SideBarMenuRow>
        <OntologyItemRow gap='1ch' center>
          <Icon />
          <OntologyTitle>{title}</OntologyTitle>
        </OntologyItemRow>
      </SideBarMenuRow>
    </StyledLink>
  );
}

const StyledLink = styled(AtomicLink)`
  display: block;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
  overflow: hidden;
  white-space: nowrap;
`;

const OntologyItemRow = styled(Row)`
  flex: 1;
  min-width: 0;
  width: 100%;
`;

const OntologyTitle = styled.span`
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;
