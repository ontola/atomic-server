import React, {
  createContext,
  SetStateAction,
  Dispatch,
  PropsWithChildren,
  useState,
  useContext,
  useEffect,
} from 'react';

const CurrentSubjectContext = createContext<{
  currentSubject: string;
  setCurrentSubject: Dispatch<SetStateAction<string>>;
}>({
  currentSubject: '',
  setCurrentSubject: () => '',
});

export const CurrentSubjectProvider = ({
  currentSubject: initialSubject,
  children,
}: PropsWithChildren<{ currentSubject: string }>) => {
  const [currentSubject, setCurrentSubject] = useState(initialSubject);

  useEffect(() => {
    setCurrentSubject(initialSubject);
  }, [initialSubject]);

  return (
    <CurrentSubjectContext.Provider
      value={{ currentSubject, setCurrentSubject }}
    >
      {children}
    </CurrentSubjectContext.Provider>
  );
};

export const useCurrentSubject = () => {
  const context = useContext(CurrentSubjectContext);

  if (!context) {
    throw new Error(
      'useCurrentSubject must be used within a CurrentSubjectProvider',
    );
  }

  return context;
};
