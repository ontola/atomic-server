import { useInsertionEffect } from 'react';
import { CurrentBackgroundColor } from '../globalCssVars';

export function useCustomBodyColor(color: string) {
  useInsertionEffect(() => {
    document.body.style.setProperty(CurrentBackgroundColor.raw, color);

    return () => {
      document.body.style.removeProperty(CurrentBackgroundColor.raw);
    };
  }, [color]);
}
