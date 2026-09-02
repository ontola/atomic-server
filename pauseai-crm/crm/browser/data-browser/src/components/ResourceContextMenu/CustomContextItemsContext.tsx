import {
  createContext,
  useContext,
  useState,
  useCallback,
  type PropsWithChildren,
  useEffect,
} from 'react';
import type { DropdownItem } from '../Dropdown';

export interface CustomContextItemsContextValue {
  items: DropdownItem[];
  registerItems: (items: DropdownItem[]) => () => void;
}

const CustomContextItemsContext = createContext<
  CustomContextItemsContextValue | undefined
>(undefined);

export function CustomContextItemsProvider({ children }: PropsWithChildren) {
  const [itemsMap, setItemsMap] = useState<Map<string, DropdownItem[]>>(
    new Map(),
  );

  const registerItems = useCallback((items: DropdownItem[]) => {
    const id = Math.random().toString(36).substring(7);

    setItemsMap(prev => {
      const next = new Map(prev);
      next.set(id, items);

      return next;
    });

    // Return cleanup function
    return () => {
      setItemsMap(prev => {
        const next = new Map(prev);
        next.delete(id);

        return next;
      });
    };
  }, []);

  const items = Array.from(itemsMap.values()).flat();

  return (
    <CustomContextItemsContext.Provider value={{ items, registerItems }}>
      {children}
    </CustomContextItemsContext.Provider>
  );
}

export function useCustomContextItemsContext() {
  const context = useContext(CustomContextItemsContext);

  if (!context) {
    throw new Error(
      'useCustomContextItemsContext must be used within CustomContextItemsProvider',
    );
  }

  return context;
}

/**
 * Hook to register custom context menu items for the ResourceContextMenu.
 * The items will be automatically cleaned up when the component unmounts.
 *
 * @param items - Array of DropdownItem to add to the context menu
 *
 * @example
 * ```tsx
 * useCustomContextItems([
 *   {
 *     id: 'export-pdf',
 *     label: 'Export as PDF',
 *     helper: 'Export this document as a PDF file',
 *     icon: <FaFilePdf />,
 *     onClick: () => handleExportPDF(),
 *   },
 *   DIVIDER,
 * ]);
 * ```
 */
export function useCustomContextItems(items: DropdownItem[]) {
  const { registerItems } = useCustomContextItemsContext();

  useEffect(() => {
    const cleanup = registerItems(items);

    return cleanup;
  }, [registerItems, items]);
}
