import { Button } from '@components/Button';
import { Dialog, useDialog } from '@components/Dialog';
import type { Resource, Server } from '@tomic/react';
import { useId, useRef, useState } from 'react';
import { FaPlus } from 'react-icons/fa6';
import {
  TextWriter,
  Uint8ArrayReader,
  ZipReader,
  type Entry,
} from '@zip.js/zip.js';
import { styled } from 'styled-components';
import { Column, Row } from '@components/Row';
import { JSONEditor } from '@components/JSONEditor';
import Markdown from '@components/datatypes/Markdown';
import { useCreatePlugin, type PluginMetadata } from './createPlugin';

interface NewPluginButtonProps {
  drive: Resource<Server.Drive>;
}

export const NewPluginButton: React.FC<NewPluginButtonProps> = ({ drive }) => {
  const configLabelId = useId();
  const [error, setError] = useState<string>();
  const [file, setFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [metadata, setMetadata] = useState<PluginMetadata>();
  const [configValid, setConfigValid] = useState(true);
  const { createPluginResource, installPlugin } = useCreatePlugin();
  const [dialogProps, show, hide] = useDialog({
    onCancel: () => {
      setError(undefined);
      setFile(null);
      setMetadata(undefined);
      fileInputRef.current!.value = '';
    },
    onSuccess: async () => {
      if (!metadata || !file) {
        return setError('Please fill in all fields');
      }

      try {
        const plugin = await createPluginResource({ metadata, file, drive });
        await installPlugin(plugin, drive);
      } catch (err) {
        setError(`Failed to install plugin, error: ${err.message}`);
      } finally {
        setError(undefined);
        setFile(null);
        setMetadata(undefined);
        fileInputRef.current!.value = '';
      }
    },
  });

  const handleFileInputChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const targetFile = e.target.files?.[0];

    if (targetFile) {
      try {
        const readMetadata = await readZip(targetFile);
        setMetadata(readMetadata);
        setFile(targetFile);
        setError(undefined);
        show();
      } catch (err) {
        setError(err.message);
      }
    }
  };

  return (
    <>
      <label>
        <Button as='div'>
          <FaPlus aria-hidden /> Upload Plugin
        </Button>
        <input
          ref={fileInputRef}
          type='file'
          style={{ display: 'none' }}
          accept='application/zip'
          onChange={handleFileInputChange}
        />
      </label>
      {error && <p>{error}</p>}
      <Dialog {...dialogProps} width='800px'>
        <Dialog.Title>
          <h1>Add Plugin</h1>
        </Dialog.Title>
        <Dialog.Content>
          {metadata && (
            <Column>
              <div>
                <Row justify='space-between'>
                  <PluginName>
                    {metadata.namespace}/{metadata.name}
                  </PluginName>
                  <span>v{metadata.version}</span>
                </Row>
                <PluginAuthor>by {metadata.author}</PluginAuthor>
              </div>
              {metadata.description && (
                <DescriptionWrapper>
                  <Markdown text={metadata.description} />
                </DescriptionWrapper>
              )}

              <Label id={configLabelId}>Config</Label>
              <JSONEditor
                labelId={configLabelId}
                initialValue={JSON.stringify(metadata.defaultConfig, null, 2)}
                onChange={() => {}}
                schema={metadata.configSchema}
                showErrorStyling={!configValid}
                onValidationChange={setConfigValid}
              />
            </Column>
          )}
          {!metadata && (
            <label>
              <Button as='div'>
                <FaPlus aria-hidden /> Upload Plugin
              </Button>
              <input
                type='file'
                style={{ display: 'none' }}
                accept='application/zip'
                onChange={handleFileInputChange}
              />
            </label>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onClick={() => hide(false)} subtle>
            Cancel
          </Button>
          <Button
            onClick={() => hide(true)}
            disabled={!metadata || !configValid}
          >
            Install
          </Button>
        </Dialog.Actions>
      </Dialog>
    </>
  );
};

async function readZip(file: File): Promise<PluginMetadata> {
  const zip = new ZipReader(new Uint8ArrayReader(await file.bytes()));
  const entries = await zip.getEntries();

  if (!validateZip(entries)) {
    throw new Error('Invalid plugin zip file.');
  }

  for (const entry of entries) {
    if (!entry.directory && entry.filename === 'plugin.json') {
      const metadata = await entry.getData(new TextWriter());

      return JSON.parse(metadata) as PluginMetadata;
    }
  }

  throw new Error('Plugin metadata not found in zip file.');
}

function validateZip(entries: Entry[]): boolean {
  const allowedRootFiles = ['plugin.json', 'plugin.wasm'];
  let foundWasm = false;
  let foundJson = false;

  for (const entry of entries) {
    if (entry.filename.startsWith('assets/')) {
      continue;
    }

    if (!allowedRootFiles.includes(entry.filename)) {
      return false;
    }

    if (entry.filename === 'plugin.wasm') {
      foundWasm = true;
    }

    if (entry.filename === 'plugin.json') {
      foundJson = true;
    }
  }

  return foundWasm && foundJson;
}

const PluginName = styled.span`
  font-weight: bold;
`;

const DescriptionWrapper = styled.div`
  background-color: ${p => p.theme.colors.bg1};
  padding: ${p => p.theme.size()};
  border-radius: ${p => p.theme.radius};
`;

const PluginAuthor = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const Label = styled.label`
  font-weight: bold;
`;
