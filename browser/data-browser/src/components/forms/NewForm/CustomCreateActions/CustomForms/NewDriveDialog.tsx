import { core, useStore, server, dataBrowser } from '@tomic/react';
import { useState, useCallback, FormEvent, FC, useEffect, useId } from 'react';
import { styled } from 'styled-components';
import { stringToSlug } from '../../../../../helpers/stringToSlug';
import { Button } from '../../../../Button';
import {
  useDialog,
  Dialog,
  DialogContent,
  DialogActions,
  DialogTitle,
} from '../../../../Dialog';
import Field from '../../../Field';
import { InputWrapper, InputStyled } from '../../../InputStyles';
import { CustomResourceDialogProps } from '../../useNewResourceUI';
import { useCreateAndNavigate } from '../../../../../hooks/useCreateAndNavigate';
import { useSettings } from '../../../../../helpers/AppSettings';

const SUBDOMAIN = 'https://atomicdata.dev/properties/subdomain';

export const NewDriveDialog: FC<CustomResourceDialogProps> = ({
  onClose,
  onCreated,
  skipNavigation,
}) => {
  const store = useStore();
  const nameFieldId = useId();
  const subdomainFieldId = useId();
  const { setDrive } = useSettings();
  const [name, setName] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [subdomainEdited, setSubdomainEdited] = useState(false);

  useEffect(() => {
    if (!subdomainEdited) {
      setSubdomain(stringToSlug(name));
    }
  }, [name, subdomainEdited]);

  const createAndNavigate = useCreateAndNavigate();

  const onSuccess = useCallback(async () => {
    if (!name.trim()) return;

    const agent = store.getAgent();

    if (!agent || agent.subject === undefined) {
      throw new Error(
        'No agent set in the Store, required when creating a Drive',
      );
    }

    await createAndNavigate(
      server.classes.drive,
      {
        [core.properties.name]: name,
        [core.properties.write]: [agent.subject],
        [core.properties.read]: [agent.subject],
        [SUBDOMAIN]: subdomain.trim(),
      },
      {
        noParent: true,
        skipNavigation,
        onCreated: async resource => {
          // Add the new drive to the user's saved-drives list. That list lives
          // on their PRIVATE DRIVE (the per-user home index), not on the Agent.
          // Best-effort: a user may not have provisioned a personal drive yet.
          try {
            const agentResource = await store.getResource(agent.subject!);
            const personalDrive = agentResource.get(
              core.properties.personalDrive,
            ) as string | undefined;

            if (personalDrive) {
              const driveResource = await store.getResource(personalDrive);
              driveResource.push(server.properties.drives, [resource.subject]);
              await driveResource.save();
            }
          } catch (_e) {
            // Ignore (e.g. no personal drive yet, or DID agent without a
            // writable local resource).
          }

          // Create a default ontology.
          const ontologyName = stringToSlug(name.trim());
          const ontology = await store.newResource({
            isA: core.classes.ontology,
            parent: resource.subject,
            propVals: {
              [core.properties.shortname]: ontologyName,
              [core.properties.description]:
                `Default ontology for the ${name} drive`,
              [core.properties.classes]: [],
              [core.properties.properties]: [],
              [core.properties.instances]: [],
            },
          });

          await ontology.save();

          await resource.set(
            server.properties.defaultOntology,
            ontology.subject,
          );
          await resource.set(dataBrowser.properties.subResources, [
            ontology.subject,
          ]);
          await resource.save();

          // Change current drive to new drive - do this before navigation
          setDrive(resource.subject);

          onCreated?.(resource);
        },
      },
    );

    onClose();
  }, [
    name,
    subdomain,
    createAndNavigate,
    onClose,
    setDrive,
    store,
    onCreated,
    skipNavigation,
  ]);

  const [dialogProps, show, hide] = useDialog({ onSuccess, onCancel: onClose });

  useEffect(() => {
    show();
  }, []);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <H1>New Drive</H1>
      </DialogTitle>
      <DialogContent>
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            hide(true);
          }}
        >
          <Field required label='Name' fieldId={nameFieldId}>
            <InputWrapper>
              <InputStyled
                id={nameFieldId}
                placeholder='My Drive'
                value={name}
                autoFocus={true}
                onChange={e => setName(e.target.value)}
              />
            </InputWrapper>
          </Field>
          <Field label='Subdomain' fieldId={subdomainFieldId}>
            <InputWrapper>
              <InputStyled
                id={subdomainFieldId}
                placeholder='my-drive'
                value={subdomain}
                onChange={e => {
                  setSubdomain(e.target.value);
                  setSubdomainEdited(true);
                }}
              />
            </InputWrapper>
          </Field>
        </form>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => hide(false)} subtle>
          Cancel
        </Button>
        <Button onClick={() => hide(true)} disabled={!name.trim()}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
};

const H1 = styled.h1`
  margin: 0;
`;
