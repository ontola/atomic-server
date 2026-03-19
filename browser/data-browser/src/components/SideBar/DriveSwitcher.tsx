import { Resource, core, server, useResources } from '@tomic/react';
import {
  FaGear,
  FaHardDrive,
  FaPlus,
  FaSquareCheck,
  FaRegCircle,
  FaServer,
} from 'react-icons/fa6';
import { useSettings } from '../../helpers/AppSettings';
import { constructOpenURL } from '../../helpers/navigation';
import { useDriveHistory } from '../../hooks/useDriveHistory';
import { useSavedDrives } from '../../hooks/useSavedDrives';
import { paths } from '../../routes/paths';
import { DIVIDER, DropdownMenu } from '../Dropdown';
import { buildDefaultTrigger } from '../Dropdown/DefaultTrigger';
import { useNewResourceUI } from '../forms/NewForm/useNewResourceUI';
import { useNavigateWithTransition } from '../../hooks/useNavigateWithTransition';
import { serverURLStorage } from '../../helpers/serverURLStorage';

import { isURL } from '../../helpers/isURL';

const Trigger = buildDefaultTrigger(<FaHardDrive />, 'Open Drive Settings');

function getTitle(resource: Resource): string {
  return (
    (resource.get(core.properties.name) as string) ?? resource.getSubject()
  );
}

function dedupeAFromB<K, V>(a: Map<K, V>, b: Map<K, V>): Map<K, V> {
  return new Map([...a].filter(([key]) => !b.has(key)));
}

export function DriveSwitcher() {
  const navigate = useNavigateWithTransition();
  const { drive, setDrive, agent, baseURL, setServer } = useSettings();
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

  const knownServers = serverURLStorage.getKnownServers();
  const isHttpDrive = isURL(drive);

  const items = [
    ...Array.from(savedDrivesMap.entries())
      .filter(([_, resource]) => !resource.error)
      .map(([subject, resource]) => ({
        id: subject,
        label: getTitle(resource),
        helper: `Switch to ${getTitle(resource)}`,
        disabled: false,
        onClick: () => {
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
      onClick: () =>
        createNewResource(server.classes.drive, agent?.subject ?? ''),
      disabled: !agent,
    },
    DIVIDER,
    // Dedupe history from savedDrives bause not all savedDrives might be loaded yet.
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
      id: 'active-server-header',
      label: isHttpDrive ? 'Gateway (Locked to Drive)' : 'Active Gateway',
      icon: <FaServer />,
      header: true,
      onClick: () => undefined,
    },
    ...knownServers.map(s => ({
      id: `server-${s}`,
      label: s,
      helper: isHttpDrive ? 'Cannot change gateway for HTTP drives' : `Connect via ${s}`,
      disabled: isHttpDrive || s === baseURL,
      icon: s === baseURL ? <FaSquareCheck /> : <FaRegCircle />,
      onClick: () => setServer(s),
    })),
    DIVIDER,
    {
      id: 'configure-drives',
      label: 'Configure',
      icon: <FaGear />,
      helper: 'Load drives not displayed in this list.',
      onClick: () => navigate(paths.serverSettings),
    },
  ];

  return <DropdownMenu Trigger={Trigger} items={items} />;
}
