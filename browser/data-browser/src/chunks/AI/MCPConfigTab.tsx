import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { styled } from 'styled-components';
import { Row, Column } from '@components/Row';
import { FaPlus, FaPen, FaTrash } from 'react-icons/fa6';
import { Button } from '@components/Button';
import { IconButton } from '@components/IconButton/IconButton';
import { SkeletonButton } from '@components/SkeletonButton';
import { BasicSelect } from '@components/forms/BasicSelect';
import { Input } from '@components/forms/InputStyles';
import Field from '@components/forms/Field';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { MCPServer } from './types';

const generateId = () => crypto.randomUUID();

const defaultNewServer: MCPServer = {
  id: '',
  name: '',
  url: '',
  transport: 'http',
};

interface MCPConfigTabProps {
  actionPortalElement: HTMLElement | null;
  onActionsVisibleChange: (visible: boolean) => void;
}

export const MCPConfigTab = ({
  actionPortalElement,
  onActionsVisibleChange,
}: MCPConfigTabProps) => {
  const { mcpServers, setMcpServers } = useAISettings();
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  useEffect(() => {
    return () => onActionsVisibleChange(false);
  }, [onActionsVisibleChange]);

  const handleSaveServer = () => {
    if (!editingServer) return;

    if (!editingServer.name.trim() || !editingServer.url.trim()) return;

    const serverToSave: MCPServer = {
      ...editingServer,
      name: editingServer.name.trim(),
      url: editingServer.url.trim(),
    };

    const newServers = isCreating
      ? [...mcpServers, serverToSave]
      : mcpServers.map(s => (s.id === serverToSave.id ? serverToSave : s));

    setMcpServers(newServers);
    setEditingServer(null);
    setIsCreating(false);
    onActionsVisibleChange(false);
  };

  const handleDeleteServer = (serverToDelete: MCPServer) => {
    setMcpServers(mcpServers.filter(s => s.id !== serverToDelete.id));
  };

  const handleCreateNewServer = () => {
    setEditingServer({ ...defaultNewServer, id: generateId() });
    setIsCreating(true);
    onActionsVisibleChange(true);
  };

  const handleEditServer = (server: MCPServer) => {
    setEditingServer({ ...server });
    setIsCreating(false);
    onActionsVisibleChange(true);
  };

  const handleCancel = () => {
    setEditingServer(null);
    setIsCreating(false);
    onActionsVisibleChange(false);
  };

  return (
    <>
      {editingServer ? (
        <Column>
          <ServerForm server={editingServer} onChange={setEditingServer} />
        </Column>
      ) : (
        <Column>
          <ServerList role='list' aria-label='MCP Servers'>
            {mcpServers.map(server => (
              <ServerItem key={server.id}>
                <Column gap='0.25rem'>
                  <strong>{server.name}</strong>
                  <SubtleText>{server.url}</SubtleText>
                  <SubtleText>Transport: {server.transport}</SubtleText>
                </Column>
                <Row>
                  <IconButton
                    title='Edit Server'
                    onClick={() => handleEditServer(server)}
                  >
                    <FaPen />
                  </IconButton>
                  <IconButton
                    title='Delete Server'
                    color='alert'
                    onClick={() => handleDeleteServer(server)}
                  >
                    <FaTrash />
                  </IconButton>
                </Row>
              </ServerItem>
            ))}
            {mcpServers.length === 0 && (
              <SubtleText>No MCP servers configured yet.</SubtleText>
            )}
          </ServerList>

          <CreateButton onClick={handleCreateNewServer}>
            <FaPlus title='' /> Add New Server
          </CreateButton>
        </Column>
      )}
      {editingServer &&
        actionPortalElement &&
        createPortal(
          <>
            <Button subtle onClick={handleCancel}>
              Cancel
            </Button>
            <Button
              onClick={handleSaveServer}
              disabled={!editingServer.name.trim() || !editingServer.url.trim()}
            >
              {isCreating ? 'Create Server' : 'Save Changes'}
            </Button>
          </>,
          actionPortalElement,
        )}
    </>
  );
};

interface ServerFormProps {
  server: MCPServer;
  onChange: (server: MCPServer) => void;
}

const ServerForm = ({ server, onChange }: ServerFormProps) => {
  const nameId = useId();
  const urlId = useId();
  const transportId = useId();

  return (
    <Column>
      <Field
        helperAlwaysVisible
        required
        label='Name'
        helper='A friendly name for this MCP server'
        fieldId={nameId}
      >
        <Input
          required
          value={server.name}
          onChange={e => onChange({ ...server, name: e.target.value })}
          placeholder='e.g., my-mcp-server'
          id={nameId}
        />
      </Field>

      <Field
        helperAlwaysVisible
        required
        label='URL'
        helper='The URL where the MCP server can be reached'
        fieldId={urlId}
      >
        <Input
          required
          type='url'
          inputMode='url'
          pattern='https?://.*'
          value={server.url}
          onChange={e => onChange({ ...server, url: e.target.value })}
          placeholder='https://example.com/mcp'
          id={urlId}
        />
      </Field>

      <Field
        helperAlwaysVisible
        label='Transport'
        helper='The transport protocol used to communicate with the server'
        fieldId={transportId}
      >
        <BasicSelect
          id={transportId}
          value={server.transport}
          onChange={e =>
            onChange({
              ...server,
              transport: e.target.value as 'http' | 'sse',
            })
          }
          title='Select transport type'
        >
          <option value='http'>HTTP</option>
          <option value='sse'>SSE</option>
        </BasicSelect>
      </Field>
    </Column>
  );
};

const ServerList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
`;

const ServerItem = styled.li`
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
