import React, { type JSX } from 'react';
import { Resource, useResource } from '@tomic/react';
import { Detail } from './Detail';
import { getIconForClass } from '@tomic/resource-ui/helpers/iconMap';
import { InlineFormattedResourceList } from '@tomic/resource-ui/components/InlineFormattedResourceList';
import { AtomicLink } from '@tomic/resource-ui/components/AtomicLink';
import { Row } from '@tomic/ui/components/Row';

type ClassDetailProps = {
  resource: Resource;
};

/** Renders the is-a Class for some resource */
export const ClassDetail: React.FC<ClassDetailProps> = ({ resource }) => {
  if (resource.getClasses().length === 0) {
    return null;
  }

  return (
    <Row gap='1ch'>
      <InlineFormattedResourceList
        subjects={resource.getClasses()}
        RenderComp={ClassItem}
      />
    </Row>
  );
};

interface ClassItemProps {
  subject: string;
}

const ClassItem = ({ subject }: ClassItemProps): JSX.Element => {
  const classResource = useResource(subject);
  const Icon = getIconForClass(subject);

  return (
    <Detail>
      <Icon />
      <AtomicLink subject={subject}>{classResource.title}</AtomicLink>
    </Detail>
  );
};
