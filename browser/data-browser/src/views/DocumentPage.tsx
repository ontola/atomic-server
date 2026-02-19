import { useState, type JSX } from 'react';
import { useArray, useCanWrite, dataBrowser, useStore } from '@tomic/react';
import { styled } from 'styled-components';
import { FaCircleInfo } from 'react-icons/fa6';

import { ElementShow } from './Element';
import { Button } from '../components/Button';
import { ResourcePageProps } from './ResourcePage';
import { Column, Row } from '../components/Row';
import { TagBar } from '../components/Tag/TagBar';
import { upgradeDocument } from './Document/upgradeDocument';
import toast from 'react-hot-toast';

/** A full page, editable document, consisting of Elements */
export function DocumentPage({ resource }: ResourcePageProps): JSX.Element {
  const store = useStore();
  const canWrite = useCanWrite(resource);
  const [elements] = useArray(resource, dataBrowser.properties.elements);
  const [upgrading, setUpgrading] = useState(false);

  return (
    <FullPageWrapper>
      <DocumentContainer>
        <Column fullHeight>
          <Row>
            <h1>{resource.title}</h1>
          </Row>
          <TagBar resource={resource} />
          {canWrite && (
            <UpgradeMessage>
              <Row align='baseline'>
                <FaCircleInfo />
                This document needs to be updated to the new format in order to
                be edited.
              </Row>
              <Button
                disabled={upgrading}
                onClick={() => {
                  setUpgrading(true);
                  upgradeDocument(resource, store).catch(e => {
                    console.error(e);
                    toast.error('Could not update document');
                    setUpgrading(false);
                  });
                }}
              >
                Update Document
              </Button>
            </UpgradeMessage>
          )}
          <div>
            {elements.map(subject => (
              <ElementShow subject={subject} key={subject} />
            ))}
          </div>
        </Column>
      </DocumentContainer>
    </FullPageWrapper>
  );
}

const DocumentContainer = styled.div`
  width: min(100%, ${p => p.theme.containerWidth}rem);
  margin: auto;
  display: flex;
  flex: 1;
  flex-direction: column;
  padding: 2rem;
  @media (max-width: ${props => props.theme.containerWidth}rem) {
    padding: ${p => p.theme.size()};
  }
`;

const FullPageWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg};
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: ${p => p.theme.heights.fullPage};
  box-sizing: border-box;
`;

const UpgradeMessage = styled(Column)`
  background-color: ${p => p.theme.colors.mainSelectedBg};
  border: 1px solid ${p => p.theme.colors.mainSelectedFg};
  color: ${p => p.theme.colors.mainSelectedFg};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

export default DocumentPage;
