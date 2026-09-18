import {
  useString,
  useCreatedAt,
  useCreatedBy,
  useArray,
  core,
  notifications,
} from '@tomic/react';

import { CommitDetail } from '../components/CommitDetail';
import { ContainerNarrow } from '../components/Containers';
import Markdown from '../components/datatypes/Markdown';
import { Details } from '../components/Detail';
import { ResourceInline } from './ResourceInline';
import { ResourcePageProps } from './ResourcePage';

/** Full-page view for a DirectMessage. */
export function DirectMessagePage({ resource }: ResourcePageProps) {
  const [description] = useString(resource, core.properties.description);
  const [mentions] = useArray(resource, notifications.properties.mentions);
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);

  return (
    <ContainerNarrow>
      <h3>Message</h3>
      <Details>
        <CommitDetail createdAt={createdAt} createdBy={createdBy} />
      </Details>
      {mentions.length > 0 && (
        <p>
          To{' '}
          {mentions.map(subject => (
            <ResourceInline key={subject} subject={subject} />
          ))}
        </p>
      )}
      <Markdown text={description || ''} />
    </ContainerNarrow>
  );
}
