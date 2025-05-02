import { FC, useEffect } from 'react';
import { getSupportedCurrencyList } from './currencies';
import { BasicSelect } from '../../components/forms/BasicSelect';
import { Resource, dataBrowser, useString } from '@tomic/react';

interface CurrencyPickerProps {
  resource: Resource;
}

const supportedCurrencies = getSupportedCurrencyList();

const getSymbol = (code: string) => {
  return new Intl.NumberFormat('default', {
    style: 'currency',
    currency: code,
    currencyDisplay: 'narrowSymbol',
  })
    .formatToParts(0)
    .find(part => part.type === 'currency')?.value;
};

const CurrencyPicker: FC<CurrencyPickerProps> = ({ resource }) => {
  const [currency, setCurrency] = useString(
    resource,
    dataBrowser.properties.currency,
  );

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setCurrency(e.target.value);
  };

  useEffect(() => {
    if (currency === undefined) {
      setCurrency('EUR');
    }

    // We only want to run this effect once. Maybe we should find a better way to do this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <BasicSelect defaultValue={currency ?? 'EUR'} onChange={handleChange}>
      {supportedCurrencies.map(c => (
        <option
          key={c.code}
          value={c.code}
          label={`${c.code} ${c.name ?? ''} (${getSymbol(c.code)})`}
        >
          {c.code}
        </option>
      ))}
    </BasicSelect>
  );
};

export default CurrencyPicker;
