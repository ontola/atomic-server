import type { Resource } from '@tomic/lib';
import { EditableDescription } from '@/components/EditableField';
import type { TextBlock as TextBlockType } from '@/ontologies/website';

const TextBlock = ({ resource }: { resource: Resource<TextBlockType> }) => {
  return (
    <EditableDescription
      subject={resource.subject}
      initialValue={resource.props.description}
    />
  );
};

export default TextBlock;
