import {
  useString,
  useResource,
  Client,
  useArray,
  core,
  dataBrowser,
  server,
  getMessageForErrorType,
} from '@tomic/react';
import { AtomicLink } from '../../components/AtomicLink';
import { ErrorLook } from '../../components/ErrorLook';
import { LoaderInline } from '../../components/Loader';
import { TagInline } from './TagInline';
import { FileInline } from './FileInline';

import type { JSX } from 'react';

export type ResourceInlineInstanceProps = {
  subject: string;
};

type ResourceInlineProps = {
  untabbable?: boolean;
  className?: string;
  basic?: boolean;
} & ResourceInlineInstanceProps;

/** Renders a Resource in a compact, inline link. Shows tooltip on hover. */
export function ResourceInline({
  subject,
  untabbable,
  basic,
  className,
}: ResourceInlineProps): JSX.Element {
  const resource = useResource(subject, { allowIncomplete: true });
  const [isA] = useArray(resource, core.properties.isA);

  const Comp = basic ? DefaultInline : (classMap.get(isA[0]) ?? DefaultInline);

  if (!subject) {
    return <ErrorLook>No subject passed</ErrorLook>;
  }

  if (resource.error) {
    return (
      <AtomicLink subject={subject} untabbable={untabbable}>
        <ErrorLook about={subject} title={resource.error.message}>
          {getMessageForErrorType(resource.error)}
        </ErrorLook>
      </AtomicLink>
    );
  }

  if (resource.loading) {
    return <LoaderInline about={subject}>loading</LoaderInline>;
  }

  if (!Client.isValidSubject(subject)) {
    return <ErrorLook>{subject} is not a valid subject.</ErrorLook>;
  }

  return (
    <AtomicLink subject={subject} untabbable={untabbable} className={className}>
      <Comp subject={subject} />
    </AtomicLink>
  );
}

function DefaultInline({ subject }: ResourceInlineInstanceProps): JSX.Element {
  const resource = useResource(subject);
  const [description] = useString(resource, core.properties.description);

  return <span title={description ? description : ''}>{resource.title}</span>;
}

const classMap = new Map<
  string,
  (props: ResourceInlineInstanceProps) => JSX.Element
>([
  [dataBrowser.classes.tag, TagInline],
  [server.classes.file, FileInline],
]);
