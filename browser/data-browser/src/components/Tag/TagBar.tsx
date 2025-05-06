import {
  dataBrowser,
  useArray,
  useCanWrite,
  useResource,
  useStore,
  type Resource,
} from '@tomic/react';
import { FaPlus, FaTags } from 'react-icons/fa6';
import { Row } from '../Row';
import * as RadixPopover from '@radix-ui/react-popover';
import { SkeletonButton } from '../SkeletonButton';
import styled from 'styled-components';
import { ResourceInline } from '../../views/ResourceInline';
import { useEffect, useState } from 'react';
import { TagSelectPopover } from './TagSelectPopover';
import { getResourcesDrive } from '@helpers/getResourcesDrive';

interface TagBarProps {
  resource: Resource;
}

const useDriveTags = (resource: Resource) => {
  const store = useStore();
  const [driveSubject, setDriveSubject] = useState<string>();
  const drive = useResource(driveSubject);
  const [driveTags, setDriveTags] = useArray(
    drive,
    dataBrowser.properties.tagList,
    {
      commit: true,
    },
  );

  const canCreateTags = useCanWrite(drive);

  useEffect(() => {
    getResourcesDrive(resource, store).then(setDriveSubject);
  }, [resource, store]);

  const addDriveTag = (tagSubject: string) => {
    return setDriveTags([...driveTags, tagSubject]);
  };

  return {
    driveTags,
    addDriveTag,
    driveSubject,
    canCreateTags,
  };
};

export const TagBar: React.FC<TagBarProps> = ({ resource }) => {
  const { driveTags, addDriveTag, driveSubject, canCreateTags } =
    useDriveTags(resource);
  const canWrite = useCanWrite(resource);
  const [tags, setTags] = useArray(resource, dataBrowser.properties.tags, {
    commit: true,
  });

  const handleNewTag = (newTag: string) => {
    addDriveTag(newTag);
  };

  if (driveSubject === undefined || resource.loading) {
    return (
      <Row center gap='0.5rem'>
        <FaTags />
        <SkeletonButton>
          <FaPlus />
        </SkeletonButton>
      </Row>
    );
  }

  return (
    <Row center gap='0.5rem' wrapItems>
      <FaTags />
      {tags.map(tag => (
        <ResourceInline key={tag} subject={tag} />
      ))}
      {canWrite && (
        <TagSelectPopover
          tags={driveTags}
          selectedTags={tags}
          setSelectedTags={setTags}
          onNewTag={canCreateTags ? handleNewTag : undefined}
          newTagParent={canCreateTags ? driveSubject : undefined}
          Trigger={
            <NewTagButton as={RadixPopover.Trigger} title='Add tags'>
              <FaPlus />
            </NewTagButton>
          }
        />
      )}
    </Row>
  );
};

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

const NewTagButton = styled(SkeletonButton)`
  padding-inline: ${p => p.theme.size(4)};
  padding-block: 0.4em;
  border-radius: 1em;
`;
