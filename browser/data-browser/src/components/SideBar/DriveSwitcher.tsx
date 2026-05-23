import { Resource, core, server, useResources } from '@tomic/react';
import { useMemo } from 'react';
import {
  FaGear,
  FaHardDrive,
  FaPlus,
  FaSquareCheck,
  FaRegCircle,
} from 'react-icons/fa6';
import { useSettings } from '../../helpers/AppSettings';
import { constructOpenURL } from '../../helpers/navigation';
import { useDriveHistory } from '../../hooks/useDriveHistory';
import { useSavedDrives } from '../../hooks/useSavedDrives';
import { paths } from '../../routes/paths';
import { type DropdownItem, DIVIDER, DropdownMenu } from '../Dropdown';
import { buildDefaultTrigger } from '../Dropdown/DefaultTrigger';
import type { DropdownTriggerComponent } from '../Dropdown/DropdownTrigger';
import { useNewResourceUI } from '../forms/NewForm/useNewResourceUI';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';

const DefaultTrigger = buildDefaultTrigger(
  <FaHardDrive />,
  'Open Drive Settings',
);

function getTitle(resource: Resource): string {
  return (resource.get(core.properties.name) as string) ?? resource.subject;
}

function dedupeAFromB<K, V>(a: Map<K, V>, b: Map<K, V>): Map<K, V> {
  return new Map([...a].filter(([key]) => !b.has(key)));
}

export function DriveSwitcher({
  Trigger = DefaultTrigger,
}: {
  Trigger?: DropdownTriggerComponent;
}) {
  const navigate = useNavigateWithTransition();
  const { drive, setDrive, agent } = useSettings();
  const [savedDrives] = useSavedDrives();
  const [history, addToHistory] = useDriveHistory(savedDrives, 5);

  const savedDrivesMap = useResources(savedDrives);
  const historyMap = useResources(history);

  const buildHandleHistoryDriveClick = (subject: string) => () => {
    setDrive(subject);
    addToHistory(subject);
    navigate(constructOpenURL(subject));
  };

  const createNewResource = useNewResourceUI();

  const items = useMemo<DropdownItem[]>(
    () => [
      ...Array.from(savedDrivesMap.entries())
        .filter(([_, resource]) => !resource.error)
        .map(([subject, resource]) => ({
          id: subject,
          label: getTitle(resource),
          helper: `Switch to ${getTitle(resource)}`,
          disabled: false,
          onClick: (): void => {
            setDrive(subject);
            navigate(constructOpenURL(subject));
          },
          icon: subject === drive ? <FaSquareCheck /> : <FaRegCircle />,
        })),
      {
        id: 'new-drive',
        label: 'New Drive',
        icon: <FaPlus />,
        helper: 'Create a new drive',
        onClick: (): void =>
          createNewResource(server.classes.drive, agent?.subject ?? ''),
        disabled: !agent,
      },
      DIVIDER,
      ...Array.from(dedupeAFromB(historyMap, savedDrivesMap))
        .map(([subject, resource]) => ({
          label: getTitle(resource),
          id: subject,
          helper: `Switch to ${getTitle(resource)}`,
          icon: subject === drive ? <FaSquareCheck /> : <FaRegCircle />,
          onClick: buildHandleHistoryDriveClick(subject),
          disabled: false,
        }))
        .slice(0, 5),
      DIVIDER,
      {
        id: 'configure-drives',
        label: 'Configure',
        icon: <FaGear />,
        helper: 'Load drives not displayed in this list.',
        onClick: (): void => {
          void navigate(paths.serverSettings);
        },
      },
    ],
    [
      agent,
      createNewResource,
      drive,
      historyMap,
      navigate,
      savedDrivesMap,
      setDrive,
    ],
  );

  return <DropdownMenu Trigger={Trigger} items={items} />;
}
