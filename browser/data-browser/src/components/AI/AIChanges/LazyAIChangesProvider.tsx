import { createContext, lazy, Suspense, useCallback, useState } from 'react';
import {
  AIChangesContext,
  defaultAIChangesValue,
  type AIChangesContextType,
} from '@components/AIChangesContext';

const AIChangesRuntime = lazy(() =>
  import('./AIChangesRuntime').then(m => ({ default: m.AIChangesRuntime })),
);

interface LazyAIChangesContextType {
  load: () => void;
  isLoaded: boolean;
  isRuntimeReady: boolean;
}

export const LazyAIChangesContext = createContext<LazyAIChangesContextType>({
  load: () => {},
  isLoaded: false,
  isRuntimeReady: false,
});

/** Lazy-loads AI review runtime after `load()`; keeps a stable provider boundary. */
export const LazyAIChangesProvider: React.FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const [isRuntimeReady, setIsRuntimeReady] = useState(false);
  const [value, setValue] = useState<AIChangesContextType>(
    defaultAIChangesValue,
  );

  const load = useCallback(() => {
    setIsLoaded(true);
  }, []);

  const onRuntimeReady = useCallback(() => {
    setIsRuntimeReady(true);
  }, []);

  return (
    <LazyAIChangesContext.Provider value={{ load, isLoaded, isRuntimeReady }}>
      <AIChangesContext.Provider value={value}>
        {children}
        {isLoaded && (
          <Suspense fallback={null}>
            <AIChangesRuntime
              setValue={setValue}
              onRuntimeReady={onRuntimeReady}
            />
          </Suspense>
        )}
      </AIChangesContext.Provider>
    </LazyAIChangesContext.Provider>
  );
};
