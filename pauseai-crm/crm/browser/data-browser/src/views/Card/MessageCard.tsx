import { useString, useCreatedAt, useCreatedBy, core } from '@tomic/react';

import { CommitDetail } from '../../components/CommitDetail';
import Markdown from '../../components/datatypes/Markdown';
import { Detail, Details } from '../../components/Detail';
import { ResourceInline } from '../ResourceInline';
import { ResourcePageProps } from '../ResourcePage';

/** Card Message view that shows parent */
export function MessageCard({ resource }: ResourcePageProps) {
  const [description] = useString(resource, core.properties.description);
  const [parent] = useString(resource, core.properties.parent);
  // Creation date + creator from the genesis change in the resource's own Loro
  // oplog — no commit fetch, so they survive a refresh.
  const createdAt = useCreatedAt(resource);
  const createdBy = useCreatedBy(resource);

  return (
    <>
      <Details>
        <Detail>
          Message in <ResourceInline subject={parent!} />
        </Detail>
        <CommitDetail createdAt={createdAt} createdBy={createdBy} />
      </Details>
      <Markdown text={description || ''} />
    </>
  );
}
