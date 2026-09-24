import { JSONValue, useResource } from '@tomic/react';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';
import { getCategoryFromResource } from '../PropertyForm/categories';
import { SelectCell } from './SelectCell';
import { MultiRelationCell } from './MultiRelationCell';

import type { JSX } from 'react';

// Both cells below edit the same resource-array value and differ only in the
// picker they show, so a property that has not loaded yet (category
// `undefined`) can render as a relation and switch to a select once its
// datatype lands.
function ResourceArrayCellEdit(props: EditCellProps<JSONValue>): JSX.Element {
  const propResource = useResource(props.property);

  if (getCategoryFromResource(propResource) === 'select') {
    return <SelectCell.Edit {...props} />;
  } else {
    return <MultiRelationCell.Edit {...props} />;
  }
}

function ResourceArrayCellDisplay(
  props: DisplayCellProps<JSONValue>,
): JSX.Element {
  const property = useResource(props.property);

  if (getCategoryFromResource(property) === 'select') {
    return <SelectCell.Display {...props} />;
  } else {
    return <MultiRelationCell.Display {...props} />;
  }
}

export const ResourceArrayCell: CellContainer<JSONValue> = {
  Edit: ResourceArrayCellEdit,
  Display: ResourceArrayCellDisplay,
};
