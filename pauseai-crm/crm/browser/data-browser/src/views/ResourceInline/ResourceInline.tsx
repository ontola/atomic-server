import {
  useString,
  useSubject,
  useResource,
  Client,
  useArray,
  core,
  dataBrowser,
  server,
  getMessageForErrorType,
  isTransportError,
} from '@tomic/react';
import { styled } from 'styled-components';
import { ResourceGlyph } from '../../components/ResourceGlyph';
import { AtomicLink } from '../../components/AtomicLink';
import { ErrorLook } from '../../components/ErrorLook';
import { LoaderInline } from '../../components/Loader';
import { TagInline } from './TagInline';
import { FileInline } from './FileInline';

import type { JSX } from 'react';

export type ResourceInlineInstanceProps = {
  subject: string;
  /** Render the title only. For places that already show the resource's
   *  picture next to this link, like a chat message's avatar. */
  hideGlyph?: boolean;
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
  hideGlyph,
  className,
}: ResourceInlineProps): JSX.Element {
  const resource = useResource(subject, { allowIncomplete: true });
  const [isA] = useArray(resource, core.properties.isA);

  const Comp = basic ? DefaultInline : (classMap.get(isA[0]) ?? DefaultInline);

  if (!subject) {
    return <ErrorLook>No subject passed</ErrorLook>;
  }

  // A resource we can name is worth rendering, even if the last fetch for
  // it failed to reach the server: the name is what this component is for,
  // and replacing it with an error hides information we already have (the
  // chat message whose author renders their own avatar next to "Error
  // loading resource"). Errors the server actually reported — 404, 401 —
  // still win, because there the emptiness is the answer.
  if (resource.error && !(isTransportError(resource.error) && isA.length > 0)) {
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
      <Comp subject={subject} hideGlyph={hideGlyph} />
    </AtomicLink>
  );
}

function DefaultInline({
  subject,
  hideGlyph,
}: ResourceInlineInstanceProps): JSX.Element {
  // `allowIncomplete`, like the parent: an inline link needs a title, not a
  // complete resource. Without it this second `useResource` re-requested the
  // same subject under stricter terms and forced the server round-trip the
  // parent deliberately opted out of.
  const resource = useResource(subject, { allowIncomplete: true });
  const [description] = useString(resource, core.properties.description);
  const [emoji] = useString(resource, dataBrowser.properties.emoji);
  const [iconImage] = useSubject(resource, dataBrowser.properties.icon);
  const showGlyph = !hideGlyph && (emoji || iconImage);

  return (
    <InlineText title={description ? description : ''}>
      {showGlyph && <ResourceGlyph resource={resource} requireCustom />}
      {showGlyph && emoji && !iconImage ? ' ' : ''}
      {resource.title}
    </InlineText>
  );
}

/** Space between an icon image and the title (emoji get a text space). */
const InlineText = styled.span`
  & > img {
    margin-right: 0.35ch;
  }
`;

const classMap = new Map<
  string,
  (props: ResourceInlineInstanceProps) => JSX.Element
>([
  [dataBrowser.classes.tag, TagInline],
  [server.classes.file, FileInline],
]);
