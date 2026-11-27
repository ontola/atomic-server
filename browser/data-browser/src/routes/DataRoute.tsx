import { useState, type JSX } from 'react';
import {
  useResource,
  useSaveState,
  useCreatedAt,
  useCreatedBy,
  signRequest,
  HeadersObject,
  useStore,
  isAtomicIdentifier,
} from '@tomic/react';

import AllProps from '@tomic/resource-ui/components/AllProps';
import { OneLine } from '@tomic/resource-ui/components/ValueComp';
import { ContainerNarrow } from '../components/Containers';
import { AtomicLink } from '@tomic/resource-ui/components/AtomicLink';
import { useCurrentSubject } from '../helpers/useCurrentSubject';
import { PropValRow, PropertyLabel } from '../components/PropVal';
import { CommitDetail } from '../components/CommitDetail';
import { Button } from '@tomic/ui/components/Button';
import { ErrMessage } from '@tomic/ui/components/forms/InputStyles';
import { useSettings } from '../helpers/AppSettings';
import { CodeBlock } from '../components/CodeBlock';
import { Title } from '@tomic/resource-ui/components/Title';
import { Column, Row } from '@tomic/ui/components/Row';
import { ErrorLook } from '../components/ErrorLook';
import { ResourceUsage } from '@tomic/resource-ui/components/ResourceUsage/index';
import { Main } from '../components/Main';
import { IconButton } from '@tomic/ui/components/IconButton/IconButton';
import { FaArrowLeft } from 'react-icons/fa6';
import { constructOpenURL } from '../helpers/navigation';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';
import { createRoute } from '@tanstack/react-router';

export const DataRoute = createRoute({
  path: pathNames.data,
  component: () => <Data />,
  getParentRoute: () => appRoute,
});

/** Renders the data of some Resource */
function Data(): JSX.Element {
  const [subject] = useCurrentSubject();
  const resource = useResource(subject);
  const saveState = useSaveState(resource);
  // Creation metadata derived from the signed genesis commit (the resource
  // identity), materialized into propvals — not a refetched commit.
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);
  const [textResponse, setTextResponse] = useState<string | undefined>(
    undefined,
  );
  const [textResponseLoading, setTextResponseLoading] = useState(false);
  const [err, setErr] = useState<Error | undefined>(undefined);
  const { agent } = useSettings();
  const navigate = useNavigateWithTransition();
  const store = useStore();

  if (!subject) {
    <ContainerNarrow>No subject passed</ContainerNarrow>;
  }

  if (resource.loading) {
    return <ContainerNarrow>Loading {subject}...</ContainerNarrow>;
  }

  if (resource.error) {
    return (
      <ContainerNarrow>
        <ErrorLook>{resource.error.message}</ErrorLook>
      </ContainerNarrow>
    );
  }

  async function fetchAs(contentType: string) {
    if (!subject) return;

    let headers: HeadersObject = {};
    headers['Accept'] = contentType;

    let url = subject;

    if (isAtomicIdentifier(subject)) {
      url = `${store.getServerUrl()}/resource?subject=${encodeURIComponent(subject)}`;
    }

    if (agent) {
      headers = await signRequest(url, agent, headers);
    }

    setTextResponseLoading(true);

    try {
      const resp = await window.fetch(url, { headers: headers });
      const body = await resp.text();
      setTextResponseLoading(false);
      setTextResponse(body);
      setErr(undefined);
    } catch (e) {
      setTextResponseLoading(false);
      setErr(e);
    }
  }

  const handleBackClick = () => {
    navigate(constructOpenURL(subject ?? ''));
  };

  return (
    <Main subject={subject}>
      <ContainerNarrow about={subject}>
        <Column>
          <Row center gap='1ch'>
            <IconButton
              size='1.4em'
              title={`Back to ${resource.title}`}
              onClick={handleBackClick}
            >
              <FaArrowLeft />
            </IconButton>
            <Title resource={resource} prefix='Data for' link />
          </Row>
          <AllProps resource={resource} editable columns>
            <PropValRow>
              <PropertyLabel title='The URL of the resource'>
                subject
              </PropertyLabel>
              <OneLine title={subject}>
                <AtomicLink subject={subject}>{subject}</AtomicLink>
              </OneLine>
            </PropValRow>
            {(createdBy || createdAt) && (
              <PropValRow>
                <PropertyLabel title='Creator and creation time, derived from the signed genesis commit (the resource identity). For DID resources the subject above IS the genesis signature.'>
                  genesis
                </PropertyLabel>
                <OneLine>
                  <CommitDetail createdAt={createdAt} createdBy={createdBy} />
                </OneLine>
              </PropValRow>
            )}
          </AllProps>
          {saveState.kind !== 'idle' ? (
            <>
              <h2>⚠️ contains uncommitted changes</h2>
              <p>
                This means that (some) of your local changes are not yet saved.
              </p>
              {saveState.error && <ErrMessage>{saveState.error}</ErrMessage>}
              <Button
                disabled={saveState.kind === 'saving'}
                onClick={() => resource.save()}
              >
                save
              </Button>
            </>
          ) : null}
          <h2>Code</h2>
          <Row wrapItems>
            <Button
              subtle
              onClick={() => fetchAs('application/ad+json')}
              data-test='fetch-json-ad'
            >
              JSON-AD
            </Button>
            <Button
              subtle
              onClick={() => fetchAs('application/json')}
              data-test='fetch-json'
            >
              JSON
            </Button>
            <Button
              subtle
              onClick={() => fetchAs('application/ld+json')}
              data-test='fetch-json-ld'
            >
              JSON-LD
            </Button>
            <Button
              subtle
              onClick={() => fetchAs('text/turtle')}
              data-test='fetch-turtle'
            >
              Turtle / N-triples / N3
            </Button>
          </Row>
          {err && <ErrMessage>{err.message}</ErrMessage>}
          {!err && textResponse && (
            <CodeBlock content={textResponse} loading={textResponseLoading} />
          )}
          <h2>Usage</h2>
          <ResourceUsage resource={resource} />
        </Column>
      </ContainerNarrow>
    </Main>
  );
}
