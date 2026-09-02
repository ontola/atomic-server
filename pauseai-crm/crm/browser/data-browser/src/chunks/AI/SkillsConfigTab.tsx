import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';
import { Row, Column } from '@components/Row';
import { FaPlus, FaPen, FaTrash } from 'react-icons/fa6';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton/IconButton';
import { SkeletonButton } from '@components/SkeletonButton';
import { MarkdownInput } from '@components/forms/MarkdownInput';
import { Checkbox } from '@components/forms/Checkbox';
import { AgentSkill, useSkillsConfig } from './skills/skill';
import Field from '@components/forms/Field';
import { Input } from '@components/forms/InputStyles';
import { stringToSlug } from '@helpers/stringToSlug';

// Helper function to generate a unique ID
const generateId = () => {
  return `custom-user-skill.${Math.random().toString(36).substring(2, 11)}`;
};

const defaultNewSkill: AgentSkill = {
  meta: {
    id: '',
    name: '',
    description: '',
  },
  content: '',
  references: [],
};

interface SkillsConfigTabProps {
  actionPortalElement: HTMLElement | null;
  onActionsVisibleChange: (visible: boolean) => void;
}

export const SkillsConfigTab = ({
  actionPortalElement,
  onActionsVisibleChange,
}: SkillsConfigTabProps) => {
  const { userSkills, saveUserSkills } = useSkillsConfig();
  const [editingSkill, setEditingSkill] = useState<AgentSkill | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    return () => onActionsVisibleChange(false);
  }, [onActionsVisibleChange]);

  const handleSaveSkill = () => {
    if (!editingSkill) return;

    // ensure name is a valid string, perhaps replace spaces with dashes
    const newMeta = {
      ...editingSkill.meta,
      name: stringToSlug(editingSkill.meta.name.trim()),
    };
    const skillToSave = { ...editingSkill, meta: newMeta };

    const newSkills = isCreating
      ? [...userSkills, skillToSave]
      : userSkills.map(skill =>
          skill.meta.id === skillToSave.meta.id ? skillToSave : skill,
        );

    saveUserSkills(newSkills);
    setEditingSkill(null);
    setIsCreating(false);
    onActionsVisibleChange(false);
  };

  const handleDeleteSkill = (skillToDelete: AgentSkill) => {
    const newSkills = userSkills.filter(
      skill => skill.meta.id !== skillToDelete.meta.id,
    );
    saveUserSkills(newSkills);
  };

  const handleCreateNewSkill = () => {
    setEditingSkill({
      ...defaultNewSkill,
      meta: {
        ...defaultNewSkill.meta,
        id: generateId(),
      },
    });
    setIsCreating(true);
    onActionsVisibleChange(true);
  };

  const handleEditSkill = (skill: AgentSkill) => {
    setEditingSkill({ ...skill });
    setIsCreating(false);
    onActionsVisibleChange(true);
  };

  const handleCancel = () => {
    setEditingSkill(null);
    setIsCreating(false);
    onActionsVisibleChange(false);
  };

  return (
    <>
      {editingSkill ? (
        <Column>
          <SkillForm skill={editingSkill} onChange={setEditingSkill} />
        </Column>
      ) : (
        <Column>
          <SkillsList role='list' aria-label='AI Skills'>
            {userSkills.map(skill => (
              <SkillItem key={skill.meta.id}>
                <Row center gap='1rem'>
                  <Checkbox
                    checked={!skill.meta.disabled}
                    onChange={checked => {
                      const newSkills = userSkills.map(s =>
                        s.meta.id === skill.meta.id
                          ? { ...s, meta: { ...s.meta, disabled: !checked } }
                          : s,
                      );
                      saveUserSkills(newSkills);
                    }}
                  />
                  <Column gap='0'>
                    <strong>{skill.meta.name}</strong>
                    <SubtleText>{skill.meta.description}</SubtleText>
                  </Column>
                </Row>
                <Row>
                  <IconButton
                    title='Edit Skill'
                    onClick={() => handleEditSkill(skill)}
                  >
                    <FaPen />
                  </IconButton>
                  <IconButton
                    title='Delete Skill'
                    color='alert'
                    onClick={() => handleDeleteSkill(skill)}
                  >
                    <FaTrash />
                  </IconButton>
                </Row>
              </SkillItem>
            ))}
            {userSkills.length === 0 && (
              <SubtleText>No custom skills created yet.</SubtleText>
            )}
          </SkillsList>

          <CreateButton onClick={handleCreateNewSkill}>
            <FaPlus title='' /> Create New Skill
          </CreateButton>
        </Column>
      )}
      {editingSkill &&
        actionPortalElement &&
        createPortal(
          <>
            <Button subtle onClick={handleCancel}>
              Cancel
            </Button>
            <Button onClick={handleSaveSkill}>
              {isCreating ? 'Create Skill' : 'Save Changes'}
            </Button>
          </>,
          actionPortalElement,
        )}
    </>
  );
};

interface SkillFormProps {
  skill: AgentSkill;
  onChange: (skill: AgentSkill) => void;
}

const SkillForm = ({ skill, onChange }: SkillFormProps) => {
  const nameId = useId();
  const descriptionId = useId();
  const contentId = useId();

  const handleChangeMeta = (field: keyof AgentSkill['meta'], value: string) => {
    onChange({
      ...skill,
      meta: {
        ...skill.meta,
        [field]: value,
      },
    });
  };

  return (
    <Column>
      <Field
        helperAlwaysVisible
        required
        label='Name'
        helper='The Agent will see this name'
        fieldId={nameId}
      >
        <Input
          required
          max={50}
          value={skill.meta.name}
          onChange={e =>
            handleChangeMeta(
              'name',
              e.target.value.toLowerCase().replace(/\s+/g, '-'),
            )
          }
          placeholder='e.g., custom-table-helper'
          id={nameId}
        />
      </Field>

      <Field
        helperAlwaysVisible
        required
        label='Description'
        helper='Tells the agent when to activate this skill'
        fieldId={descriptionId}
      >
        <Input
          required
          value={skill.meta.description}
          onChange={e => handleChangeMeta('description', e.target.value)}
          placeholder='Use this skill when...'
          id={descriptionId}
        />
      </Field>

      <Field label='Content' fieldId={contentId}>
        <MarkdownInput
          key={skill.meta.id}
          id={contentId}
          initialContent={skill.content}
          onChange={content => onChange({ ...skill, content })}
          placeholder='Write the markdown documentation for the skill here...'
        />
      </Field>

      <Field
        multiInput
        helperAlwaysVisible
        label='References'
        helper='Additional context. Reference these in your main content for
            additional instructions/processes that are not always needed when
            using this skill.'
      >
        <Column>
          {skill.references?.map((ref, index) => (
            <ReferenceContainer key={index}>
              <Row center justify='space-between'>
                <Field.Label>Path</Field.Label>
                <IconButton
                  title='Remove Reference'
                  color='alert'
                  onClick={() => {
                    const newRefs = [...(skill.references || [])];
                    newRefs.splice(index, 1);
                    onChange({ ...skill, references: newRefs });
                  }}
                >
                  <FaTrash />
                </IconButton>
              </Row>
              <Input
                value={ref.path}
                onChange={e => {
                  const newRefs = [...(skill.references || [])];
                  newRefs[index] = { ...newRefs[index], path: e.target.value };
                  onChange({ ...skill, references: newRefs });
                }}
                placeholder='e.g., /existing-customer-flow'
              />
              <Field.Label>Content</Field.Label>
              <MarkdownInput
                key={skill.meta.id + '-ref-' + index}
                initialContent={ref.content}
                onChange={content => {
                  const newRefs = [...(skill.references || [])];
                  newRefs[index] = { ...newRefs[index], content };
                  onChange({ ...skill, references: newRefs });
                }}
                placeholder='Markdown content for this reference...'
              />
            </ReferenceContainer>
          ))}
        </Column>
        <Button
          subtle
          onClick={() => {
            const newRefs = [
              ...(skill.references || []),
              { path: '', content: '' },
            ];
            onChange({ ...skill, references: newRefs });
          }}
        >
          <FaPlus /> Add Reference
        </Button>
      </Field>
    </Column>
  );
};

// Styled components
const SkillsList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
`;

const SkillItem = styled.li`
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: ${p => p.theme.size(2)};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  margin: 0;
`;

const CreateButton = styled(SkeletonButton)`
  height: 3rem;
`;

const SubtleText = styled.p`
  margin: 0;
  font-size: 0.875rem;
  color: ${p => p.theme.colors.textLight};
`;

const ReferenceContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};
  padding: ${p => p.theme.size(2)};
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
`;
