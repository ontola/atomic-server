import { urls, useString, useResource, useTitle, core } from '@tomic/react';
import { ResourceInline } from './ResourceInline';
import { ErrorLook } from '../components/ErrorLook';
import { styled } from 'styled-components';
import { getIconForClass } from '../helpers/iconMap';

import type { JSX } from 'react';

type Props = {
  subject: string;
  clickable?: boolean;
  className?: string;
  selected?: boolean;
};

const RootDiv = styled.div`
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.5rem;
`;

/** Renders a Resource in a small line item. Not a link. Useful in dropdown. */
function ResourceRow({
  subject,
  clickable,
  className,
  selected,
}: Props): JSX.Element {
  const resource = useResource(subject);
  const [title] = useTitle(resource);
  let [description] = useString(resource, urls.properties.description);

  if (resource.loading) {
    return <span about={subject}>Loading...</span>;
  }

  if (resource.error) {
    return (
      <ErrorLook about={subject}>Error: {resource.error.message}</ErrorLook>
    );
  }

  const TRUNCATE_LENGTH = 40;

  if (description && description.length >= TRUNCATE_LENGTH) {
    description = description.slice(0, TRUNCATE_LENGTH) + '...';
  }

  const classes = resource.getClasses();
  const mainClass = classes[0];
  const ClassIcon = mainClass ? getIconForClass(mainClass) : null;

  return (
    <RootDiv about={subject} className={className}>
      <Content>
        {clickable ? (
          <ResourceInline untabbable subject={subject} basic />
        ) : (
          <b>{title}</b>
        )}
        <ResourceRowDescription>
          {description ? ` - ${description}` : null}
        </ResourceRowDescription>
      </Content>
      {ClassIcon && (
        <IconWrapper>
          <ClassIcon />
        </IconWrapper>
      )}
    </RootDiv>
  );
}

const Content = styled.div`
  flex: 1;
  min-width: 0;
`;

const IconWrapper = styled.div`
  flex-shrink: 0;
  opacity: 0.5;
  font-size: 0.875em;
`;

export const ResourceRowDescription = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

// Alias for backwards compatibility
export const ResourceLineDescription = ResourceRowDescription;

export { ResourceRow };

export default ResourceRow;

// Alias for backwards compatibility
export { ResourceRow as ResourceLine };
