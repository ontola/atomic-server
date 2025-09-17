import { ai, core, dataBrowser } from '@tomic/react';
import { OutlinedSection } from '../../components/OutlinedSection';
import { ClassButton } from './ClassButton';

import type { JSX } from 'react';
import { useAISettings } from '@components/AI/AISettingsContext';

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
  const { enableAI } = useAISettings();
  const filteredButtons = enableAI ? [...buttons, ai.classes.aiChat] : buttons;

  return (
    <OutlinedSection extraPadding title='Base classes'>
      {filteredButtons.map(classType => (
        <ClassButton key={classType} classType={classType} parent={parent} />
      ))}
    </OutlinedSection>
  );
}
