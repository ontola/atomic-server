import { ErrorBoundary, render } from 'solid-js/web';
import { AtomicContextProvider } from './AtomicContext';
import { App } from './App';

const View = () => {
  return (
    <AtomicContextProvider>
      <ErrorBoundary fallback={error => <div>Error: {error.message}</div>}>
        <App />
      </ErrorBoundary>
    </AtomicContextProvider>
  );
};

render(() => <View />, document.getElementById('root')!);
