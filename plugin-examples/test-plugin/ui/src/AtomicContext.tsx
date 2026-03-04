import {
  createContext,
  createEffect,
  createSignal,
  useContext,
  type ParentProps,
} from 'solid-js';
import { type PageContext, type Resource, RPCClient } from '@tomic/plugin';

const rpcClient = new RPCClient();
const context = await rpcClient.getPageContext();

interface AtomicContextType extends Omit<PageContext, 'resource'> {
  client: RPCClient;
  resource: () => Resource;
}

const AtomicContext = createContext<AtomicContextType>({
  resource: () => context.resource,
  agent: context.agent,
  client: rpcClient,
});

export const AtomicContextProvider = (props: ParentProps) => {
  const [resource, setResource] = createSignal<Resource>(context.resource);

  createEffect(() => {
    return rpcClient.subscribe(context.resource.subject, setResource);
  });

  return (
    <AtomicContext.Provider
      value={{
        resource,
        agent: context.agent,
        client: rpcClient,
      }}
    >
      {props.children}
    </AtomicContext.Provider>
  );
};

export const useAtomicContext = () => {
  return useContext(AtomicContext)!;
};
