import { classes } from '@tomic/react';
import { useMemo, type JSX } from 'react';
import { FaList, FaGrip } from 'react-icons/fa6';
import { ButtonGroup } from '../../components/ButtonGroup';

export interface DisplayStyleButtonProps {
  displayStyle: string | undefined;
  onClick: (displayStyle: string) => void;
}

const { grid, list } = classes.displayStyles;

export function DisplayStyleButton({
  displayStyle,
  onClick,
}: DisplayStyleButtonProps): JSX.Element {
  const options = useMemo(
    () => [
      {
        icon: <FaList />,
        label: 'List View',
        value: list,
        checked: displayStyle === list,
      },
      {
        icon: <FaGrip />,
        label: 'Grid View',
        value: grid,
        checked: displayStyle === grid,
      },
    ],
    [displayStyle],
  );

  return (
    <ButtonGroup options={options} name='display-style' onChange={onClick} />
  );
}
