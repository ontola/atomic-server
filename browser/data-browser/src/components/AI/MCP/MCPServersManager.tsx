import { useState } from 'react';
import { styled } from 'styled-components';
import { FaPlus, FaXmark } from 'react-icons/fa6';
import { Column, Row } from '../../Row';
import { InputStyled, InputWrapper } from '../../forms/InputStyles';
import { IconButton, IconButtonVariant } from '../../IconButton/IconButton';
import type { MCPServer } from '../../../chunks/AI/types';
import { BasicSelect } from '../../forms/BasicSelect';
import { ServerItem } from './ServerItem';
import { Collapse } from '../../Collapse';

interface MCPServersManagerProps {
  servers: MCPServer[];
  setServers: (servers: MCPServer[]) => void;
}

export const MCPServersManager: React.FC<MCPServersManagerProps> = ({
  servers,
  setServers,
}) => {
  const [showAddForm, setShowAddForm] = useState(false);
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
    setShowAddForm(false);
  };

  const onServerUpdated = (updated: MCPServer) => {
    setServers(servers.map(s => (s.id === updated.id ? updated : s)));
  };

  const onRemoveServer = (id: string) => {
    setServers(servers.filter(s => s.id !== id));
  };

  return (
    <Column gap='0.5rem'>
      {servers.length === 0 && !showAddForm ? (
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
      <Collapse open={showAddForm}>
        <AddForm
          onSubmit={e => {
            e.preventDefault();
            addMcpServer();
          }}
        >
          <Row gap='0.5rem' align='flex-end' wrapItems>
            <Column gap='0.25rem'>
              <FormLabel htmlFor='server-name'>Name</FormLabel>
              <InputWrapper>
                <InputStyled
                  id='server-name'
                  type='text'
                  value={newServerName}
                  onChange={e => setNewServerName(e.target.value)}
                  placeholder='Server name'
                />
              </InputWrapper>
            </Column>
            <Column gap='0.25rem'>
              <FormLabel htmlFor='server-url'>URL</FormLabel>
              <InputWrapper>
                <InputStyled
                  id='server-url'
                  type='text'
                  inputMode='url'
                  pattern='https?://.*'
                  value={newServerUrl}
                  onChange={e => setNewServerUrl(e.target.value)}
                  placeholder='Server URL'
                />
              </InputWrapper>
            </Column>
            <Column gap='0.25rem'>
              <FormLabel htmlFor='server-transport'>Type</FormLabel>
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
              type='submit'
              disabled={!newServerName || !newServerUrl}
              title='Add server'
            >
              <FaPlus />
            </IconButton>
          </Row>
        </AddForm>
      </Collapse>
      <Row>
        <IconButton
          title={showAddForm ? 'Cancel' : 'Add server'}
          onClick={() => setShowAddForm(prev => !prev)}
          color={showAddForm ? 'textLight' : 'main'}
        >
          {showAddForm ? <FaXmark /> : <FaPlus />}
        </IconButton>
      </Row>
    </Column>
  );
};

const EmptyMessage = styled.p`
  text-align: center;
  color: ${p => p.theme.colors.textLight};
  font-style: italic;
  margin: 0;
`;

const AddForm = styled.form`
  padding-top: 0.5rem;
`;

const FormLabel = styled.label`
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const StyledSelect = styled(BasicSelect)`
  select {
    min-width: 7ch;
    margin-left: 0.5rem;
  }
`;
