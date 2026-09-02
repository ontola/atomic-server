import {
  useString,
  useCreatedAt,
  useCreatedBy,
  properties,
} from '@tomic/react';

import { CommitDetail } from '../components/CommitDetail';
import { ContainerNarrow } from '../components/Containers';
import Markdown from '../components/datatypes/Markdown';
import { Details } from '../components/Detail';
import { ResourceInline } from './ResourceInline';
import { ResourcePageProps } from './ResourcePage';

/** Full page Message view that should (in the future) render replies */
export function MessagePage({ resource }: ResourcePageProps) {
  const [description] = useString(resource, properties.description);
  const [parent] = useString(resource, properties.parent);
  // Creation date + creator from the genesis change in the resource's own Loro
  // oplog — no commit fetch, so they survive a refresh.
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);

  return (
    <ContainerNarrow>
      <h3>
        Message in <ResourceInline subject={parent!} />
      </h3>
      <Details>
        <CommitDetail createdAt={createdAt} createdBy={createdBy} />
      </Details>
      <Markdown text={description || ''} />
    </ContainerNarrow>
  );
}
