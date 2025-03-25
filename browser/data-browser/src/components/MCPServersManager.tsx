import { useState } from 'react';
import { styled } from 'styled-components';
import { FaPlus, FaTrash } from 'react-icons/fa6';
import { Column, Row } from './Row';
import { InputStyled, InputWrapper } from './forms/InputStyles';
import { IconButton, IconButtonVariant } from './IconButton/IconButton';
import type { MCPServer } from './AI/types';

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

  const addMcpServer = () => {
    if (newServerName.trim() === '' || newServerUrl.trim() === '') {
      return;
    }

    const newServer: MCPServer = {
      name: newServerName.trim(),
      url: newServerUrl.trim(),
      id: crypto.randomUUID(),
    };

    setServers([...servers, newServer]);
    setNewServerName('');
    setNewServerUrl('');
  };

  const removeMcpServer = (index: number) => {
    const updatedServers = [...servers];
    updatedServers.splice(index, 1);
    setServers(updatedServers);
  };

  return (
    <Column gap='1rem'>
      <ServerList>
        {servers.length === 0 ? (
          <EmptyMessage>No MCP servers configured</EmptyMessage>
        ) : (
          servers.map((server, index) => (
            <ServerItem key={index}>
              <ServerDetails>
                <ServerName>{server.name}</ServerName>
                <ServerUrl>{server.url}</ServerUrl>
              </ServerDetails>
              <IconButton
                color='alert'
                onClick={() => removeMcpServer(index)}
                title='Remove server'
              >
                <FaTrash />
              </IconButton>
            </ServerItem>
          ))
        )}
      </ServerList>
      <Column gap='0.5rem'>
        <h4>Add Server</h4>
        <Row gap='1rem' center>
          <Column gap='0.5rem' style={{ flex: 1 }}>
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
          <Column gap='0.5rem' style={{ flex: 2 }}>
            <label htmlFor='server-url'>Server URL</label>
            <Row>
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

const ServerItem = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  border-radius: 4px;
  background-color: ${p => p.theme.colors.bg1};
  border: 1px solid ${p => p.theme.colors.bg2};
`;

const ServerDetails = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
`;

const ServerName = styled.div`
  font-weight: bold;
`;

const ServerUrl = styled.div`
  font-size: 0.9em;
  color: ${p => p.theme.colors.textLight};
`;

const EmptyMessage = styled.div`
  padding: ${p => p.theme.size()};
  text-align: center;
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
`;
