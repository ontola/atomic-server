import type { Runtime } from 'wuchale/runtime';
export declare const getRuntime: (loadID?: number) => Runtime;
export declare function subscribeRuntime(
  loadID: number,
  callback: (runtime: Runtime) => void,
): () => void;
export declare function loadAtomicLocale(locale: string): Promise<void>;
