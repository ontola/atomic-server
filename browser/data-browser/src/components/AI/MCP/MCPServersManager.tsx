import { useState } from 'react';
import { styled } from 'styled-components';
import { FaPlus } from 'react-icons/fa6';
import { Column, Row } from '../../Row';
import { InputStyled, InputWrapper } from '../../forms/InputStyles';
import { IconButton, IconButtonVariant } from '../../IconButton/IconButton';
import type { MCPServer } from '../types';
import { BasicSelect } from '../../forms/BasicSelect';
import { ServerItem } from './ServerItem';

interface MCPServersManagerProps {
  servers: MCPServer[];
  setServers: (servers: MCPServer[]) => void;
}

export const MCPServersManager: React.FC<MCPServersManagerProps> = ({
  servers,
  setServers,
}) => {
  const [newServerName, setNewServerName] = useState('');
  const [newServerUrl, setNewServerUrl] = useState('');
  const [newServerTransport, setNewServerTransport] = useState<'http' | 'sse'>(
    'http',
  );

  const addMcpServer = () => {
    if (newServerName.trim() === '' || newServerUrl.trim() === '') {
      return;
    }

    const newServer: MCPServer = {
      name: newServerName.trim(),
      url: newServerUrl.trim(),
      id: crypto.randomUUID(),
      transport: newServerTransport,
    };

    setServers([...servers, newServer]);
    setNewServerName('');
    setNewServerUrl('');
    setNewServerTransport('http');
  };

  const onServerUpdated = (updated: MCPServer) => {
    setServers(servers.map(s => (s.id === updated.id ? updated : s)));
  };

  const onRemoveServer = (id: string) => {
    setServers(servers.filter(s => s.id !== id));
  };

  return (
    <Column gap='1rem'>
      <ServerList>
        {servers.length === 0 ? (
          <EmptyMessage>No MCP servers configured</EmptyMessage>
        ) : (
          servers.map(server => (
            <ServerItem
              key={server.id}
              server={server}
              onServerUpdated={onServerUpdated}
              onRemove={() => onRemoveServer(server.id)}
              disabled={false}
            />
          ))
        )}
      </ServerList>
      <Column gap='0.5rem'>
        <h4>Add Server</h4>
        <Row gap='1rem' align='flex-end'>
          <Column gap='0.5rem'>
            <label htmlFor='server-name'>Server Name</label>
            <InputWrapper>
              <InputStyled
                id='server-name'
                type='text'
                value={newServerName}
                onChange={e => setNewServerName(e.target.value)}
                placeholder='Enter server name'
              />
            </InputWrapper>
          </Column>
          <Column gap='0.5rem'>
            <label htmlFor='server-url'>Server URL</label>
            <InputWrapper>
              <InputStyled
                id='server-url'
                type='text'
                inputMode='url'
                pattern='https?://.*'
                value={newServerUrl}
                onChange={e => setNewServerUrl(e.target.value)}
                placeholder='Enter server URL'
              />
            </InputWrapper>
          </Column>
          <Column gap='0.5rem'>
            <label htmlFor='server-transport'>Type</label>
            <StyledSelect
              id='server-transport'
              value={newServerTransport}
              onChange={e =>
                setNewServerTransport(e.target.value as 'http' | 'sse')
              }
              title='Select transport type'
            >
              <option value='http'>HTTP</option>
              <option value='sse'>SSE</option>
            </StyledSelect>
          </Column>
          <IconButton
            variant={IconButtonVariant.Fill}
            onClick={addMcpServer}
            disabled={!newServerName || !newServerUrl}
            title='Add server'
          >
            <FaPlus />
          </IconButton>
        </Row>
      </Column>
    </Column>
  );
};

const ServerList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1rem;
`;

const EmptyMessage = styled.div`
  padding: ${p => p.theme.size()};
  text-align: center;
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;

const StyledSelect = styled(BasicSelect)`
  select {
    min-width: 7ch;
    margin-left: 0.5rem;
  }
`;
