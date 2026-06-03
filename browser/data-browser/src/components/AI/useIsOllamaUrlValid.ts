import { effectFetch } from '@helpers/effectFetch';
import { useDeferredValue, useEffect, useState } from 'react';

const MODEL_API_ROUTE = '/api/tags';

type OllamaCheckResult = {
  url: string;
  valid: boolean;
};

export const useIsOllamaUrlValid = (url: string | undefined) => {
  const deferredUrl = useDeferredValue(url);
  const [checkResult, setCheckResult] = useState<OllamaCheckResult | null>(
    null,
  );

  useEffect(() => {
    if (!deferredUrl) {
      return;
    }

    const modelAPIURL = `${deferredUrl}${MODEL_API_ROUTE}`;

    return effectFetch(modelAPIURL, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    })(
      () => {
        setCheckResult({ url: deferredUrl, valid: true });
      },
      () => {
        setCheckResult({ url: deferredUrl, valid: false });
      },
    );
  }, [deferredUrl]);

  if (!url) {
    return false;
  }

  return (
    checkResult !== null && checkResult.url === deferredUrl && checkResult.valid
  );
};
