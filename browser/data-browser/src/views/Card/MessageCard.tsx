import { useString, core, commits } from '@tomic/react';

import { CommitDetail } from '../../components/CommitDetail';
import Markdown from '../../components/datatypes/Markdown';
import { Detail, Details } from '../../components/Detail';
import { ResourceInline } from '../ResourceInline';
import { ResourcePageProps } from '../ResourcePage';

/** Card Message view that shows parent */
export function MessageCard({ resource }: ResourcePageProps) {
  const [description] = useString(resource, core.properties.description);
  const [parent] = useString(resource, core.properties.parent);
  const [lastCommit] = useString(resource, commits.properties.lastCommit);

  return (
    <>
      <Details>
        <Detail>
          Message in <ResourceInline subject={parent!} />
        </Detail>
        <CommitDetail commitSubject={lastCommit!} />
      </Details>
      <Markdown text={description || ''} />
    </>
  );
}
