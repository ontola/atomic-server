'use client';

import { Editable } from '@tomic/edit-mode/react';
import { useResource } from '@tomic/react';
import {
  DESCRIPTION_PROP,
  NAME_PROP,
  editTarget,
  useInPlaceEdit,
} from '@/components/InPlaceEdit';
import { MarkdownContent } from '@/components/MarkdownContent';
import styles from '@/views/Block/TextBlock.module.css';

export function EditableName({
  subject,
  initialValue,
  as: Tag = 'h1',
  className,
}: {
  subject: string;
  initialValue: string;
  as?: 'h1' | 'span';
  className?: string;
}) {
  const resource = useResource(subject);
  const value = resource.loading
    ? initialValue
    : (resource.title ?? initialValue);

  return (
    <Tag className={className}>
      <Editable target={editTarget(subject, NAME_PROP)}>{value}</Editable>
    </Tag>
  );
}

export function EditableDescription({
  subject,
  initialValue,
}: {
  subject: string;
  initialValue: string;
}) {
  const { editing } = useInPlaceEdit();
  const resource = useResource(subject);
  const value = resource.loading
    ? initialValue
    : ((resource.props as { description?: string }).description ??
      initialValue);

  if (!editing) {
    return <MarkdownContent subject={subject} initialValue={initialValue} />;
  }

  return (
    <div className={styles.wrapper}>
      <Editable
        target={editTarget(subject, DESCRIPTION_PROP)}
        multiline
      >
        {value}
      </Editable>
    </div>
  );
}
