import { dataBrowser, useArray, type Resource } from '@tomic/react';
import { Row } from '../Row';
import { ResourceInline } from '../../views/ResourceInline';

interface SimpleTagBarProps {
  resource: Resource;
  small?: boolean;
}

export const SimpleTagBar: React.FC<SimpleTagBarProps> = ({
  resource,
  small,
}) => {
  const [tags] = useArray(resource, dataBrowser.properties.tags);

  if (tags.length === 0) {
    return null;
  }

  return (
    <Row
      center
      gap='0.5rem'
      wrapItems
      style={{ fontSize: small ? '0.8rem' : '1rem' }}
    >
      {tags.map(tag => (
        <ResourceInline subject={tag} key={tag} />
      ))}
    </Row>
  );
};
