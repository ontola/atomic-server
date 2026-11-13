import {
  TableNewColumnMenu,
  type TableNewColumnMenuPresentation,
} from '@tomic/table';
import { Datatype, useCanWrite, useResource } from '@tomic/react';
import { useContext, useState } from 'react';
import {
  FaBolt,
  FaCalculator,
  FaCircleChevronDown,
  FaFile,
  FaHashtag,
  FaPlus,
} from 'react-icons/fa6';
import { DIVIDER, DropdownMenu } from '@components/Dropdown';
import { buildDefaultTrigger } from '@components/Dropdown/DefaultTrigger';
import { TablePageContext } from './tablePageContext';
import { DerivedColumnDialog } from './DerivedColumnDialog';
import { RowActionDialog } from './RowActionDialog';
import { dataTypeIconMap } from '../../helpers/iconMap';
import { FaCode } from 'react-icons/fa6';

const NewColumnTrigger = buildDefaultTrigger(<FaPlus />, 'Add column');

const TextIcon = dataTypeIconMap.get(Datatype.STRING)!;
const NumberIcon = dataTypeIconMap.get(Datatype.INTEGER)!;
const DateIcon = dataTypeIconMap.get(Datatype.DATE)!;
const CheckboxIcon = dataTypeIconMap.get(Datatype.BOOLEAN)!;
const SelectIcon = FaCircleChevronDown;
const FileIcon = FaFile;
const RelationIcon = dataTypeIconMap.get(Datatype.ATOMIC_URL)!;
const LocalizedTextIcon = dataTypeIconMap.get(Datatype.LOCALIZEDTEXT)!;

export const NewColumnButton: React.FC = () => {
  const [showDerivedDialog, setShowDerivedDialog] = useState(false);
  const [showActionDialog, setShowActionDialog] = useState(false);

  const {
    tableClassSubject,
    requestColumnCreation,
    classProperties,
    addDerivedColumn,
    addRowAction,
  } = useContext(TablePageContext);
  const tableClassResource = useResource(tableClassSubject);

  const canWrite = useCanWrite(tableClassResource);

  if (!canWrite) {
    return null;
  }

  return (
    <>
      <TableNewColumnMenu
        Menu={AtomicNewColumnMenu}
        messages={{
          label: 'Add column',
          text: 'Text',
          number: 'Number',
          date: 'Date',
          checkbox: 'Checkbox',
          select: 'Select',
          file: 'File',
          json: 'JSON',
          localizedText: 'Localized Text',
          relation: 'Relation',
          computed: 'Computed',
          action: 'Action',
          external: 'External Property',
        }}
        actions={{
          text: { run: () => requestColumnCreation('text') },
          number: { run: () => requestColumnCreation('number') },
          date: { run: () => requestColumnCreation('date') },
          checkbox: { run: () => requestColumnCreation('checkbox') },
          select: { run: () => requestColumnCreation('select') },
          file: { run: () => requestColumnCreation('file') },
          json: { run: () => requestColumnCreation('json') },
          localizedText: { run: () => requestColumnCreation('localizedText') },
          relation: { run: () => requestColumnCreation('relation') },
          computed: { run: () => setShowDerivedDialog(true) },
          action: { run: () => setShowActionDialog(true) },
          external: { run: () => requestColumnCreation('external') },
        }}
        icons={{
          text: <TextIcon />,
          number: <NumberIcon />,
          date: <DateIcon />,
          checkbox: <CheckboxIcon />,
          select: <SelectIcon />,
          file: <FileIcon />,
          json: <FaCode />,
          localizedText: <LocalizedTextIcon />,
          relation: <RelationIcon />,
          computed: <FaCalculator />,
          action: <FaBolt />,
          external: <FaHashtag />,
        }}
      />
      {/* Computed columns are view config, not properties on the class — so
       *  this one writes to the active view rather than creating anything. */}
      <DerivedColumnDialog
        open={showDerivedDialog}
        bindShow={setShowDerivedDialog}
        classProperties={classProperties}
        onSave={addDerivedColumn}
      />
      {/* An action is view config too: it writes a button onto the active view
       *  rather than adding anything to the class. Mounted only while open, so
       *  its fields cannot be confused with an action column's edit dialog. */}
      {showActionDialog && (
        <RowActionDialog
          open
          bindShow={setShowActionDialog}
          classProperties={classProperties}
          onSave={addRowAction}
        />
      )}
    </>
  );
};

function AtomicNewColumnMenu({ items }: TableNewColumnMenuPresentation) {
  const commands = items.map(item => ({
    id: item.key,
    label: item.label,
    icon: item.icon,
    disabled: item.disabled,
    helper:
      item.reason ??
      (item.key === 'action'
        ? 'A button on every row: "Watered", "Mark done", "+1".'
        : undefined),
    onClick: item.run,
  }));

  return (
    <DropdownMenu
      Trigger={NewColumnTrigger}
      items={[...commands.slice(0, 9), DIVIDER, ...commands.slice(9)]}
    />
  );
}
