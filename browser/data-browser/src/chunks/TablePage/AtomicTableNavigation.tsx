import { useCallback, useMemo, type PropsWithChildren } from 'react';
import {
  TableNavigationProvider,
  useOptionalTableNavigation,
  type TableNavigation,
} from '@tomic/table';
import { ShowRoute } from '../../routes/ShowRoute';

/** Only this boundary depends on the Data Browser router. Embedded hosts can
 * supply their own navigation without mounting a second router. */
export function AtomicTableNavigation({ children }: PropsWithChildren) {
  const provided = useOptionalTableNavigation();

  return provided ? children : <RouterNavigation>{children}</RouterNavigation>;
}

function RouterNavigation({ children }: PropsWithChildren) {
  const search = ShowRoute.useSearch();
  const routeNavigate = ShowRoute.useNavigate();
  const navigate = useCallback<TableNavigation['navigate']>(
    (patch, options) =>
      routeNavigate({
        to: '.',
        search: previous => ({ ...previous, ...patch }),
        replace: options?.replace,
      }),
    [routeNavigate],
  );
  const value = useMemo<TableNavigation>(
    () => ({
      location: { view: search.view, editColumn: search.editColumn },
      navigate,
    }),
    [search.view, search.editColumn, navigate],
  );

  return (
    <TableNavigationProvider value={value}>{children}</TableNavigationProvider>
  );
}
