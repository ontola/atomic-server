import {
  core,
  dataBrowser,
  Resource,
  server,
  useArray,
  useCollection,
  useResource,
  VirtualizedCollectionList,
} from '@tomic/react';
import { Details } from '../Details';
import { useState } from 'react';
import { getIconForClass } from '../../helpers/iconMap';
import { styled } from 'styled-components';

const defaultShouldBeRendered = (resource: Resource) =>
  resource.hasClasses(dataBrowser.classes.folder) ||
  resource.hasClasses(server.classes.drive);

interface ParentPickerItemProps {
  subject: string;
  selectedValue: string | undefined;
  initialOpen?: boolean;
  shouldBeRendered?: (resource: Resource) => boolean;
  onClick: (subject: string) => void;
}

export const ParentPickerItem: React.FC<ParentPickerItemProps> = ({
  subject,
  selectedValue,
  initialOpen,
  shouldBeRendered = defaultShouldBeRendered,
  onClick,
}) => {
  const { collection } = useCollection(
    {
      property: core.properties.parent,
      value: subject,
    },
    { includeNested: true },
  );

  const [open, setOpen] = useState(initialOpen);

  if (collection.totalMembers === 0) {
    return (
      <Title
        indented
        subject={subject}
        onClick={onClick}
        selected={selectedValue === subject}
      />
    );
  }

  return (
    <Details
      initialState={initialOpen}
      open={open}
      onStateToggle={setOpen}
      title={
        <Title
          subject={subject}
          selected={selectedValue === subject}
          onClick={onClick}
        />
      }
    >
      {open && (
        <VirtualizedCollectionList collection={collection}>
          {({ resource }) => {
            if (resource.loading || !shouldBeRendered(resource)) {
              return null;
            }

            return (
              <ParentPickerItem
                key={resource.subject}
                subject={resource.subject}
                selectedValue={selectedValue}
                onClick={onClick}
                shouldBeRendered={shouldBeRendered}
              />
            );
          }}
        </VirtualizedCollectionList>
      )}
    </Details>
  );
};

interface TitleProps extends Omit<ParentPickerItemProps, 'selectedValue'> {
  indented?: boolean;
  selected?: boolean;
}

const Title = ({
  subject,
  indented,
  selected,
  onClick,
}: TitleProps): React.JSX.Element => {
  const resource = useResource(subject);
  const [isA] = useArray(resource, core.properties.isA);

  const Icon = getIconForClass(isA[0]);

  return (
    <FolderButton
      selected={selected}
      indented={indented}
      onClick={() => onClick(subject)}
    >
      <Icon />
      {resource.title}
    </FolderButton>
  );
};

const FolderButton = styled.button<{ indented?: boolean; selected?: boolean }>`
  display: flex;
  align-items: center;
  gap: 1ch;
  background-color: ${p => (p.selected ? p.theme.colors.bg1 : 'transparent')};
  color: ${p => (p.selected ? p.theme.colors.main : p.theme.colors.textLight)};
  cursor: pointer;
  border: none;
  padding: 0.3rem 0.5rem;
  margin-inline-start: ${p => (p.indented ? '2rem' : '0')};
  border-radius: ${p => p.theme.radius};
  user-select: none;
  text-align: start;

  & svg {
    flex-shrink: 0;
  }

  &:hover {
    background-color: ${p => p.theme.colors.bg1};
    color: ${p => (p.selected ? p.theme.colors.main : p.theme.colors.text)};
  }
`;
