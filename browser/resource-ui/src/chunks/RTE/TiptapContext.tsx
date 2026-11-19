import type { Editor } from '@tiptap/react';
import { createContext, useContext } from 'react';

type TiptapContextType = Editor;

export const TiptapContext = createContext<TiptapContextType>({} as Editor);

export const useTipTapEditor = (): TiptapContextType =>
  useContext(TiptapContext);

interface TipTapContextProviderProps {
  editor: Editor;
}

export const TiptapContextProvider = ({
  editor,
  children,
}: React.PropsWithChildren<TipTapContextProviderProps>) => {
  return (
    <TiptapContext.Provider value={editor}>{children}</TiptapContext.Provider>
  );
};
