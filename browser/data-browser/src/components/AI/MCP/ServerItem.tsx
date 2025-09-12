import React, { useEffect, useState } from 'react';
import { styled } from 'styled-components';
import { FaCheck, FaPencil, FaTrash, FaXmark } from 'react-icons/fa6';
import { Row } from '../../Row';
import { InputStyled, InputWrapper } from '../../forms/InputStyles';
import { IconButton, IconButtonVariant } from '../../IconButton/IconButton';
import { BasicSelect } from '../../forms/BasicSelect';
import type { MCPServer } from '../../../chunks/AI/types';

export interface ServerItemProps {
  server: MCPServer;
  onServerUpdated: (updated: MCPServer) => void;
  onRemove: () => void;
  disabled: boolean;
}

export const ServerItem: React.FC<ServerItemProps> = ({
  server,
  onServerUpdated,
  onRemove,
  disabled,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editServer, setEditServer] = useState<MCPServer>(server);

  // Keep local edit state in sync if server prop changes (e.g. after save)

  const startEdit = () => {
    setEditServer(server);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setEditServer(server);
    setIsEditing(false);
  };

  const saveEdit = () => {
    if (!editServer.name || !editServer.url || !editServer.transport) return;
    onServerUpdated(editServer);
    setIsEditing(false);
  };

  useEffect(() => {
    setEditServer(server);
  }, [server]);

  return (
    <ServerItemRoot>
      {isEditing ? (
        <ServerDetails
          as='form'
          onSubmit={e => {
            e.preventDefault();
            saveEdit();
          }}
        >
          <InputWrapper>
            <InputStyled
              type='text'
              value={editServer.name}
              onChange={e =>
                setEditServer(s => ({ ...s, name: e.target.value }))
              }
              placeholder='Server name'
              required
            />
          </InputWrapper>
          <InputWrapper>
            <InputStyled
              type='url'
              value={editServer.url}
              onChange={e =>
                setEditServer(s => ({ ...s, url: e.target.value }))
              }
              placeholder='Server URL'
              required
            />
          </InputWrapper>
          <StyledSelect
            value={editServer.transport}
            onChange={e =>
              setEditServer(s => ({
                ...s,
                transport: e.target.value as 'http' | 'sse',
              }))
            }
            title='Select transport type'
          >
            <option value='http'>HTTP</option>
            <option value='sse'>SSE</option>
          </StyledSelect>
          <Row gap='0.5rem'>
            <IconButton
              variant={IconButtonVariant.Fill}
              color='main'
              type='submit'
              title='Save changes'
              disabled={
                !editServer.name || !editServer.url || !editServer.transport
              }
            >
              <FaCheck />
            </IconButton>
            <IconButton
              color='textLight'
              onClick={cancelEdit}
              title='Cancel edit'
              type='button'
            >
              <FaXmark />
            </IconButton>
          </Row>
        </ServerDetails>
      ) : (
        <ServerDetails>
          <ServerName>{server.name}</ServerName>
          <ServerUrl>{server.url}</ServerUrl>
          <TransportType>Transport: {server.transport}</TransportType>
        </ServerDetails>
      )}
      <Row gap='0.25rem'>
        <IconButton
          color='main'
          onClick={startEdit}
          title='Edit server'
          disabled={disabled || isEditing}
        >
          <FaPencil />
        </IconButton>
        <IconButton
          color='textLight'
          onClick={onRemove}
          title='Remove server'
          disabled={disabled}
        >
          <FaTrash />
        </IconButton>
      </Row>
    </ServerItemRoot>
  );
};

const ServerItemRoot = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem;
  border-radius: 4px;
  /* background-color: ${p => p.theme.colors.bg1}; */
  border: 1px solid ${p => p.theme.colors.bg2};
`;

const ServerDetails = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  width: 100%;
`;

const ServerName = styled.div`
  font-weight: bold;
`;

const ServerUrl = styled.div`
  font-size: 0.9em;
  color: ${p => p.theme.colors.textLight};
`;

const TransportType = styled.div`
  font-size: 0.8em;
  color: ${p => p.theme.colors.textLight || '#888'};
`;

const StyledSelect = styled(BasicSelect)`
  select {
    min-width: 7ch;
    margin-left: 0.5rem;
  }
`;
