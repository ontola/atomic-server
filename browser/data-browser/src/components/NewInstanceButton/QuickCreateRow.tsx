import {
  FaComment,
  FaFileLines,
  FaFolder,
  FaPlus,
  FaTable,
} from 'react-icons/fa6';
import { type JSX } from 'react';
import { styled } from 'styled-components';
import { Button } from '../Button';
import { Row } from '../Row';
import { IconButton } from '../IconButton/IconButton';
import { useNewResourceUI } from '../forms/NewForm/useNewResourceUI';
import { dataBrowser } from '@tomic/react';
import { paths } from '../../routes/paths';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

interface QuickCreateRowProps {
  parent: string;
  className?: string;
  /** E2E: only set on the sidebar row so "New" is unique (drive/folder rows omit this). */
  newResourceButtonTestId?: string;
}

/** A row of buttons for quickly creating new resources */
export function QuickCreateRow({
  parent,
  className,
  newResourceButtonTestId,
}: QuickCreateRowProps): JSX.Element {
  const createNewResource = useNewResourceUI();
  const navigate = useNavigateWithTransition();

  return (
    <Row gap='0rem' center className={className}>
      <Button
        subtle
        title='New resource'
        data-testid={newResourceButtonTestId}
        onClick={() => navigate(paths.new)}
      >
        <FaPlus /> New
      </Button>
      <IconButtonWrapper>
        <IconButton
          color='textLight'
          title='New Document'
          onClick={() =>
            createNewResource(dataBrowser.classes.documentV2, parent)
          }
        >
          <FaFileLines />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper>
        <IconButton
          color='textLight'
          title='New Table'
          onClick={() => createNewResource(dataBrowser.classes.table, parent)}
        >
          <FaTable />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper>
        <IconButton
          color='textLight'
          title='New Folder'
          onClick={() => createNewResource(dataBrowser.classes.folder, parent)}
        >
          <FaFolder />
        </IconButton>
      </IconButtonWrapper>
      <IconButtonWrapper>
        <IconButton
          color='textLight'
          title='New ChatRoom'
          onClick={() =>
            createNewResource(dataBrowser.classes.chatroom, parent)
          }
        >
          <FaComment />
        </IconButton>
      </IconButtonWrapper>
    </Row>
  );
}

const IconButtonWrapper = styled.span`
  opacity: 0.5;
  transition: opacity 0.2s;

  &:hover {
    opacity: 1;
  }
`;
