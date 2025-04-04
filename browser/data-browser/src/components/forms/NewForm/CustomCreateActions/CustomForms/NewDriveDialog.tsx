import {
  core,
  useStore,
  server,
  dataBrowser,
  generateKeyPair,
} from '@tomic/react';
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

const DRIVE_PUBLIC_KEY = 'https://atomicdata.dev/properties/drive/publicKey';
const DRIVE_PRIVATE_KEY = 'https://atomicdata.dev/properties/drive/privateKey';
const DRIVE_HASH = 'https://atomicdata.dev/properties/drive/hash';

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export const NewDriveDialog: FC<CustomResourceDialogProps> = ({
  onClose,
  onCreated,
  skipNavigation,
}) => {
  const store = useStore();
  const nameFieldId = useId();
  const { setDrive } = useSettings();
  const [name, setName] = useState('');

  const createAndNavigate = useCreateAndNavigate();

  const onSuccess = useCallback(async () => {
    if (!name.trim()) return;

    const agent = store.getAgent();

    if (!agent || agent.subject === undefined) {
      throw new Error(
        'No agent set in the Store, required when creating a Drive',
      );
    }

    const driveKeys = await generateKeyPair();
    const drivePublicKeyBytes = decodeBase64(driveKeys.publicKey);
    const prefix = new TextEncoder().encode('atomicdata.drive');
    const hashInput = new Uint8Array(
      prefix.length + drivePublicKeyBytes.length,
    );
    hashInput.set(prefix, 0);
    hashInput.set(drivePublicKeyBytes, prefix.length);
    const digest = await crypto.subtle.digest('SHA-256', hashInput);
    const driveHash = toHex(new Uint8Array(digest).slice(0, 16));

    await createAndNavigate(
      server.classes.drive,
      {
        [core.properties.name]: name,
        [core.properties.write]: [agent.subject],
        [core.properties.read]: [agent.subject],
        [DRIVE_PUBLIC_KEY]: driveKeys.publicKey,
        [DRIVE_PRIVATE_KEY]: driveKeys.privateKey,
        [DRIVE_HASH]: driveHash,
      },
      {
        noParent: true,
        skipNavigation,
        onCreated: async resource => {
          // Add drive to the agents drive list.
          // DID agents may not have a local resource, so we ignore errors here.
          try {
            const agentResource = await store.getResource(agent.subject!);
            agentResource.push(server.properties.drives, [resource.subject]);
            await agentResource.save();
          } catch (_e) {
            // Agent resource update failed (e.g., DID agents don't have a local resource)
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
