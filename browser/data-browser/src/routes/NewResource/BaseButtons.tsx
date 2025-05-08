import { ai, core, dataBrowser } from '@tomic/react';
import { OutlinedSection } from '../../components/OutlinedSection';
import { ClassButton } from './ClassButton';

import type { JSX } from 'react';
import { useSettings } from '../../helpers/AppSettings';

interface BaseButtonsProps {
  parent: string;
}

const buttons = [
  dataBrowser.classes.table,
  dataBrowser.classes.folder,
  dataBrowser.classes.document,
  dataBrowser.classes.chatroom,
  dataBrowser.classes.bookmark,
  core.classes.ontology,
];

export function BaseButtons({ parent }: BaseButtonsProps): JSX.Element {
  const { enableAI } = useSettings();
  const filteredButtons = enableAI ? [...buttons, ai.classes.aiChat] : buttons;

  return (
    <OutlinedSection title='Base classes'>
      {filteredButtons.map(classType => (
        <ClassButton key={classType} classType={classType} parent={parent} />
      ))}
    </OutlinedSection>
  );
}
