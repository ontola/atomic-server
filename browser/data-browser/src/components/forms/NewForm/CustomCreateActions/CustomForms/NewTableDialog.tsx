import { dataBrowser, core, type Server, useStore } from '@tomic/react';
import { useState, useCallback, useEffect, useRef, FormEvent, FC } from 'react';
import { styled } from 'styled-components';
import { stringToSlug } from '../../../../../helpers/stringToSlug';
import { useSettings } from '../../../../../helpers/AppSettings';
import { BetaBadge } from '../../../../BetaBadge';
import { Button } from '../../../../Button';
import {
  useDialog,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
} from '../../../../Dialog';
import Field from '../../../Field';
import { InputWrapper, InputStyled } from '../../../InputStyles';
import type { CustomResourceDialogProps } from '../../useNewResourceUI';
import { useCreateAndNavigate } from '../../../../../hooks/useCreateAndNavigate';
import { ResourceSelector } from '../../../ResourceSelector';
import { Checkbox, CheckboxLabel } from '../../../Checkbox';
import { useAddToOntology } from '../../../../../hooks/useAddToOntology';
import {
  TABLE_TEMPLATES,
  type TableTemplate,
} from '../../../../../chunks/TablePage/tableTemplates';
import { buildTableFromSpec } from '../../../../../chunks/TablePage/createTableFromSpec';
import { useNavigateWithTransition } from '../../../../../hooks/useNavigateWithTransition';
import { constructOpenURL } from '../../../../../helpers/navigation';

interface NewTableDialogProps extends CustomResourceDialogProps {
  initialExistingClass?: string;
}

/** The name a table gets when the user doesn't type one: the template's title. */
const defaultNameFor = (template: TableTemplate): string =>
  template.spec ? template.title : 'Table';

export const NewTableDialog: FC<NewTableDialogProps> = ({
  parent,
  initialExistingClass,
  onClose,
  skipNavigation,
  onCreated,
}) => {
  const store = useStore();
  const { drive: driveSubject } = useSettings();
  const [useExistingClass, setUseExistingClass] =
    useState(!!initialExistingClass);
  const [existingClass, setExistingClass] = useState<string | undefined>(
    initialExistingClass,
  );
  const [name, setName] = useState('Table');
  const [templateId, setTemplateId] = useState('blank');
  const nameInputRef = useRef<HTMLInputElement>(null);

  const addToOntology = useAddToOntology();
  const createResourceAndNavigate = useCreateAndNavigate();
  const navigate = useNavigateWithTransition();

  const onCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  const onSuccess = useCallback(async () => {
    // A template produces a fully-configured table (class + columns + views) in
    // one shot via the shared spec builder, then we open it.
    const template = TABLE_TEMPLATES.find(t => t.id === templateId);

    if (template?.spec) {
      const { tableSubject } = await buildTableFromSpec(
        store,
        { ...template.spec, name },
        { parent, driveSubject, addToOntology },
      );

      if (!skipNavigation) {
        navigate(constructOpenURL(tableSubject));
      }

      onClose();

      return;
    }

    let classSubject: string;

    if (!useExistingClass) {
      const drive = await store.getResource<Server.Drive>(driveSubject);
      const ontologyParent = drive.props.defaultOntology;
      const parentSubject =
        ontologyParent &&
        !ontologyParent.startsWith('internal:') &&
        !ontologyParent.includes('unknown-subject')
          ? ontologyParent
          : driveSubject;
      const instanceResource = await store.newResource({
        parent: parentSubject,
        isA: core.classes.class,
        propVals: {
          [core.properties.shortname]: stringToSlug(name),
          [core.properties.description]:
            `Represents a row in the ${name} table`,
          [core.properties.recommends]: [core.properties.name],
        },
      });

      await addToOntology(instanceResource);
      classSubject = instanceResource.subject;
    } else {
      if (existingClass === undefined) {
        throw new Error('Existing class is undefined');
      }

      classSubject = existingClass;
    }

    await createResourceAndNavigate(
      dataBrowser.classes.table,
      {
        [core.properties.name]: name,
        [core.properties.classtype]: classSubject,
      },
      {
        parent,
        skipNavigation,
        onCreated,
      },
    );

    onClose();
  }, [
    name,
    templateId,
    onClose,
    parent,
    useExistingClass,
    existingClass,
    addToOntology,
    createResourceAndNavigate,
    navigate,
    skipNavigation,
    onCreated,
    store,
    driveSubject,
  ]);

  const [dialogProps, show, hide, isOpen] = useDialog({ onCancel, onSuccess });

  useEffect(() => {
    show();
  }, []);

  useEffect(() => {
    if (isOpen) {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }
  }, [isOpen]);

  const hasName = name.trim() !== '';
  const saveDisabled =
    templateId === 'blank' && useExistingClass
      ? !hasName || !existingClass
      : !hasName;

  return (
    <Dialog {...dialogProps}>
      {isOpen && (
        <>
          <RelativeDialogTitle>
            <h1>New Table</h1>
            <BetaBadge />
          </RelativeDialogTitle>
          <WiderDialogContent>
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                hide(true);
              }}
            >
              <Field label='Start from'>
                <TemplateGrid>
                  {TABLE_TEMPLATES.map(template => (
                    <TemplateCard
                      key={template.id}
                      type='button'
                      $selected={template.id === templateId}
                      onClick={() => {
                        setTemplateId(template.id);
                        // Follow the template's default name, but never
                        // overwrite a name the user typed themselves.
                        setName(prev =>
                          TABLE_TEMPLATES.some(t => prev === defaultNameFor(t))
                            ? defaultNameFor(template)
                            : prev,
                        );
                      }}
                      title={template.description}
                    >
                      <strong>{template.title}</strong>
                      <TemplateDescription>
                        {template.description}
                      </TemplateDescription>
                    </TemplateCard>
                  ))}
                </TemplateGrid>
              </Field>
              <Field required label='Name'>
                <InputWrapper>
                  <InputStyled
                    ref={nameInputRef}
                    placeholder='New Table'
                    value={name}
                    onChange={e => setName(e.target.value)}
                  />
                </InputWrapper>
              </Field>
              {templateId === 'blank' && (
                <>
                  <CheckboxLabel>
                    <Checkbox
                      checked={useExistingClass}
                      onChange={setUseExistingClass}
                    />
                    Use existing class
                  </CheckboxLabel>
                  <Field>
                    {useExistingClass && (
                      <ResourceSelector
                        hideCreateOption
                        disabled={!useExistingClass}
                        isA={core.classes.class}
                        setSubject={setExistingClass}
                        value={existingClass}
                      />
                    )}
                  </Field>
                </>
              )}
            </form>
          </WiderDialogContent>
          <DialogActions>
            <Button onClick={() => hide(false)} subtle>
              Cancel
            </Button>
            <Button onClick={() => hide(true)} disabled={saveDisabled}>
              Create
            </Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
};

const WiderDialogContent = styled(DialogContent)`
  /* width: min(80vw, 20rem); */
`;

const TemplateGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem;
`;

const TemplateCard = styled.button<{ $selected: boolean }>`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  text-align: left;
  padding: 0.6rem 0.75rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid
    ${p => (p.$selected ? p.theme.colors.main : p.theme.colors.bg2)};
  background-color: ${p =>
    p.$selected ? p.theme.colors.mainSelectedBg : p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  cursor: pointer;

  &:hover {
    border-color: ${p => p.theme.colors.main};
  }
`;

const TemplateDescription = styled.span`
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight};
`;

const RelativeDialogTitle = styled(DialogTitle)`
  display: flex;
  align-items: flex-start;
  gap: 1ch;
`;
