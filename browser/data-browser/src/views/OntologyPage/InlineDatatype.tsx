import {
  Resource,
  useString,
  core,
  reverseDatatypeMapping,
  useResource,
  type Core,
  datatypeFromUrl,
} from '@tomic/react';
import { ResourceInline } from '../ResourceInline';
import { toAnchorId } from '../../helpers/toAnchorId';
import { useOntologyContext } from './OntologyContext';

import type { JSX } from 'react';

interface TypeSuffixProps {
  resource: Resource<Core.Property>;
}

export function InlineDatatype({ resource }: TypeSuffixProps): JSX.Element {
  const datatype = resource.props.datatype;
  const [classType] = useString(resource, core.properties.classtype);
  const { hasClass } = useOntologyContext();

  const name = reverseDatatypeMapping[datatypeFromUrl(datatype)];

  if (!classType) {
    return <span>{name}</span>;
  }

  return (
    <span>
      {name}
      {'<'}
      {hasClass(classType) ? (
        <LocalLink subject={classType} />
      ) : (
        <ResourceInline subject={classType} />
      )}
      {'>'}
    </span>
  );
}

interface LocalLinkProps {
  subject: string;
}

function LocalLink({ subject }: LocalLinkProps): JSX.Element {
  const resource = useResource(subject);

  return <a href={`#${toAnchorId(subject)}`}>{resource.title}</a>;
}
