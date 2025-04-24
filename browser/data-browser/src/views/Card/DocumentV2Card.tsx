import { Column, Row } from '@components/Row';
import type { CardViewProps } from './CardViewProps';
import { ResourceCardTitle } from './ResourceCardTitle';
import {
  dataBrowser,
  useArray,
  useYDoc,
  type DataBrowser,
  type Resource,
} from '@tomic/react';
import * as Y from 'yjs';
import { Tag } from '@components/Tag';
import { ResourceContextMenu } from '@components/ResourceContextMenu';

export const DocumentV2Card: React.FC<CardViewProps> = ({ resource }) => {
  const [tags] = useArray(resource, dataBrowser.properties.tags);

  return (
    <Column gap='0.5rem'>
      <ResourceCardTitle resource={resource}>
        <Row center gap='1ch'>
          <span>document</span>
          <ResourceContextMenu simple subject={resource.subject} />
        </Row>
      </ResourceCardTitle>
      <Row gap='1ch' style={{ fontSize: '0.8rem' }}>
        {tags.map(tag => (
          <Tag subject={tag} key={tag} />
        ))}
      </Row>
      <YdocTextRenderer resource={resource} />
    </Column>
  );
};

interface AsyncDocMarkdownRendererProps {
  resource: Resource<DataBrowser.DocumentV2>;
}

const extractText = (doc: Y.Doc) => {
  const fragment = doc.getXmlFragment('content');
  let text = '';

  for (const node of fragment.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlText) {
      text += node.toString().replace(/<[^>]*>?/g, '');
    }

    if (node instanceof Y.XmlElement) {
      text += ' ';
    }

    if (text.length > 300) {
      break;
    }
  }

  return text + '...';
};

const YdocTextRenderer: React.FC<AsyncDocMarkdownRendererProps> = ({
  resource,
}) => {
  const doc = useYDoc(resource, dataBrowser.properties.documentContent);

  if (!doc) {
    return <div>Loading...</div>;
  }

  const text = extractText(doc);

  return <div>{text}</div>;
};
