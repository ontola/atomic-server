import { FaInfo } from 'react-icons/fa6';
import {
  IconButton,
  IconButtonVariant,
} from '../../components/IconButton/IconButton';
import { useState } from 'react';
import { Collapse } from '../../components/Collapse';
import { Row } from '../../components/Row';
import Markdown from '../../components/datatypes/Markdown';

interface InfoTitleProps {
  info: string;
}

export function InfoTitle({
  info,
  children,
}: React.PropsWithChildren<InfoTitleProps>) {
  const [collapsed, setCollapsed] = useState(true);

  return (
    <div>
      <Row center>
        <h2>{children}</h2>
        <IconButton
          variant={IconButtonVariant.Outline}
          color='textLight'
          type='button'
          size='0.8rem'
          onClick={() => setCollapsed(prev => !prev)}
          title='Show helper'
        >
          <FaInfo />
        </IconButton>
      </Row>
      <Collapse open={!collapsed}>
        <Markdown text={info} />
      </Collapse>
    </div>
  );
}
