import { Button } from '@components/Button';
import { Dialog } from '@components/Dialog';
import { useDialog } from '@components/Dialog/useDialog';
import type { JSONValue, Resource, Server } from '@tomic/react';
import { useRef, useState } from 'react';
import { FaUpload } from 'react-icons/fa6';
import { readZip, validateConfig, type PluginMetadata } from './plugins';
import toast from 'react-hot-toast';
import { Column, Row } from '@components/Row';
import { useCreatePlugin } from '@views/Plugin/createPlugin';
import { styled } from 'styled-components';
import type { JSONSchema7 } from 'ai';
import { JSONEditor } from '@components/JSONEditor';
import { WarningBlock } from '@components/WarningBlock';
import { ConfigReference } from '@views/Plugin/ConfigReference';

interface UpdatePluginButtonProps {
  plugin: Resource<Server.Plugin>;
}

const UpdatePluginButton: React.FC<UpdatePluginButtonProps> = ({ plugin }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [metadata, setMetadata] = useState<PluginMetadata>();
  const [configValid, setConfigValid] = useState(true);
  const [jsonEditorValid, setJsonEditorValid] = useState(true);
  const [updatedConfig, setUpdatedConfig] = useState<JSONValue>();

  const { updatePlugin } = useCreatePlugin();

  const reset = () => {
    fileInputRef.current!.value = '';
    setFile(undefined);
    setMetadata(undefined);
    setConfigValid(true);
    setJsonEditorValid(true);
    setUpdatedConfig(undefined);
  };

  const [dialogProps, show, hide] = useDialog({
    onCancel: () => {
      reset();
    },
    onSuccess: async () => {
      if (!metadata || !file) {
        return;
      }

      try {
        await updatePlugin(plugin, metadata, file, updatedConfig);
      } catch (err) {
        toast.error(err.message);
      } finally {
        reset();
      }
    },
  });

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const targetFile = e.target.files?.[0];

    if (targetFile) {
      try {
        const meta = await readZip(targetFile);

        if (
          meta.name !== plugin.props.name ||
          meta.namespace !== plugin.props.namespace
        ) {
          toast.error(
            "The update's identifier does not match the existing plugin.",
          );
          reset();

          return;
        }

        setMetadata(meta);
        setFile(targetFile);
        const valid = validateConfig(
          meta.defaultConfig,
          meta.configSchema as JSONSchema7,
        );
        setConfigValid(valid);
        show();
      } catch (err) {
        toast.error(err.message);
        reset();
      }
    }
  };

  return (
    <>
      <label>
        <Button subtle as='div'>
          <FaUpload />
          Update
        </Button>
        <input
          ref={fileInputRef}
          type='file'
          style={{ display: 'none' }}
          accept='application/zip'
          onChange={handleInputChange}
        />
      </label>
      <Dialog {...dialogProps} width='800px'>
        <Dialog.Title>
          <h1>Change Version</h1>
        </Dialog.Title>
        <Dialog.Content>
          {metadata && (
            <Column>
              <Row justify='center'>
                <VersionChange>
                  {plugin.props.version} → {metadata.version}
                </VersionChange>
              </Row>
              {!configValid && (
                <>
                  <WarningBlock>
                    Your config is not fully compatible with the new version.
                  </WarningBlock>
                  <JSONEditor
                    initialValue={JSON.stringify(plugin.props.config, null, 2)}
                    schema={metadata.configSchema as JSONSchema7}
                    onChange={val => {
                      try {
                        return setUpdatedConfig(JSON.parse(val));
                      } catch (e) {
                        // Do nothing
                      }
                    }}
                    showErrorStyling={!jsonEditorValid}
                    onValidationChange={setJsonEditorValid}
                  />
                  <ConfigReference
                    schema={metadata.configSchema as JSONSchema7}
                  />
                </>
              )}
            </Column>
          )}
        </Dialog.Content>
        <Dialog.Actions>
          <Button onClick={() => hide(false)} subtle>
            Cancel
          </Button>
          <Button
            onClick={() => hide(true)}
            disabled={!configValid && !jsonEditorValid}
          >
            Apply
          </Button>
        </Dialog.Actions>
      </Dialog>
    </>
  );
};

export default UpdatePluginButton;

const VersionChange = styled.span`
  font-weight: bold;
  font-size: 1.5rem;
`;
