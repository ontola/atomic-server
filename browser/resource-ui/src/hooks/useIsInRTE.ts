import React from 'react';

export const IsInRTEContex = React.createContext<boolean>(false);

export function useIsInRTE(): boolean {
  return React.useContext(IsInRTEContex);
}
