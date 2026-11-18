import { DeleteTableDialog } from '@tomic/table-page/TablePage/DeleteTableDialog';
import { forms, dataBrowser } from '@tomic/react';
import { registerDeleteDialog } from '@tomic/resource-ui/components/ResourceContextMenu/deleteDialogRegistry';
import { DeleteFormDialog } from '../../chunks/FormBuilder/DeleteFormDialog';

export const registerCustomDeleteDialogs = () => {
  registerDeleteDialog(forms.classes.form, DeleteFormDialog);
  registerDeleteDialog(dataBrowser.classes.table, DeleteTableDialog);
};
