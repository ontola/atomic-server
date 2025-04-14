import { effectFetch } from '@helpers/effectFetch';
import { useDeferredValue, useEffect, useState } from 'react';

const MODEL_API_ROUTE = '/api/tags';

export const useIsOllamaUrlValid = (
  enabled: boolean,
  url: string | undefined,
) => {
  const deferredUrl = useDeferredValue(url);
  const [isValid, setIsValid] = useState(false);

  useEffect(() => {
    if (!enabled || !deferredUrl) {
      return;
    }

    const modelAPIURL = `${deferredUrl}${MODEL_API_ROUTE}`;

    return effectFetch(modelAPIURL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })(
      _data => {
        setIsValid(true);
      },
      _e => {
        setIsValid(false);
      },
    );
  }, [deferredUrl, enabled]);

  return url !== undefined ? isValid : false;
};
