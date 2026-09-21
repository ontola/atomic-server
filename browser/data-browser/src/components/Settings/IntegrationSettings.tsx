import { styled } from 'styled-components';
import { useState } from 'react';
import { Checkbox, CheckboxLabel } from '@components/forms/Checkbox';
import { useIntegrationVisibility } from '@hooks/useIntegrationVisibility';
import { Column, Row } from '@components/Row';
import {
  InputStyled,
  InputWrapper,
  ErrMessage,
} from '@components/forms/InputStyles';
import { Button } from '@components/Button';
import { SettingsSection } from './SettingsSection';
import {
  defaultIntegrationProxy,
  setIntegrationProxy,
  useIntegrationProxy,
} from '@helpers/integrationProxy';
import {
  defaultPluginCatalogUrl,
  setPluginCatalogUrl,
  usePluginCatalogUrl,
} from '@helpers/pluginCatalogUrl';

export function IntegrationSettings() {
  const proxy = useIntegrationProxy();
  const catalogUrl = usePluginCatalogUrl();
  const { showApiPlugins, showExperimentalPlugins, error, setVisibility } =
    useIntegrationVisibility();

  return (
    <SettingsSection
      label='Integration'
      childSearchKeywords='proxy catalog server url localthought api experimental plugins'
    >
      <Column gap='1rem'>
        <CheckboxLabel>
          <Checkbox
            checked={showApiPlugins}
            onChange={value => setVisibility('show-api-plugins', value)}
          />
          Show API plugins
        </CheckboxLabel>
        <CheckboxLabel>
          <Checkbox
            checked={showExperimentalPlugins}
            onChange={value =>
              setVisibility('show-experimental-plugins', value)
            }
          />
          Show experimental plugins
        </CheckboxLabel>
        <Description>
          These preferences are saved in your private Atomic drive. Existing
          connections remain available.
        </Description>
        {error && <ErrMessage role='alert'>{error}</ErrMessage>}
        <ProxyForm key={proxy} proxy={proxy} />
        <CatalogUrlForm key={catalogUrl} catalogUrl={catalogUrl} />
      </Column>
    </SettingsSection>
  );
}

function ProxyForm({ proxy }: { proxy: string }) {
  const [value, setValue] = useState(proxy);
  const [error, setError] = useState('');

  return (
    <form
      onSubmit={event => {
        event.preventDefault();

        try {
          setIntegrationProxy(value);
          setError('');
        } catch {
          setError(
            'Enter an HTTPS server URL or a localhost HTTP URL, without a path.',
          );
        }
      }}
    >
      <Column gap='0.5rem'>
        <SectionTitle>Integration proxy</SectionTitle>
        <Description>
          Connect accounts and import records using a LocalThought
          integration-proxy server. This setting is saved in this browser.
        </Description>
        <Row center gap='1ch'>
          <label htmlFor='integration-proxy-url'>Integration proxy URL</label>
        </Row>
        <InputWrapper>
          <InputStyled
            id='integration-proxy-url'
            type='url'
            value={value}
            placeholder={defaultIntegrationProxy}
            onChange={event => setValue(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? 'integration-proxy-error' : undefined}
          />
        </InputWrapper>
        {error && (
          <ErrMessage id='integration-proxy-error' role='alert'>
            {error}
          </ErrMessage>
        )}
        <Row gap='0.5rem'>
          <Button type='submit' disabled={value === proxy}>
            Save
          </Button>
          <Button
            type='button'
            subtle
            onClick={() => {
              setIntegrationProxy('');
              setValue(defaultIntegrationProxy);
              setError('');
            }}
          >
            Reset to default
          </Button>
        </Row>
      </Column>
    </form>
  );
}

function CatalogUrlForm({ catalogUrl }: { catalogUrl: string }) {
  const [value, setValue] = useState(catalogUrl);
  const [error, setError] = useState('');

  return (
    <form
      onSubmit={event => {
        event.preventDefault();

        try {
          setPluginCatalogUrl(value);
          setError('');
        } catch {
          setError(
            'Enter an HTTPS URL or a localhost HTTP URL pointing at a catalog.json file.',
          );
        }
      }}
    >
      <Column gap='0.5rem'>
        <SectionTitle>Plugin catalog URL</SectionTitle>
        <Description>
          Discover integrations from this catalog.json. This setting is
          saved in this browser.
        </Description>
        <Row center gap='1ch'>
          <label htmlFor='plugin-catalog-url'>Plugin catalog URL</label>
        </Row>
        <InputWrapper>
          <InputStyled
            id='plugin-catalog-url'
            type='url'
            value={value}
            placeholder={defaultPluginCatalogUrl}
            onChange={event => setValue(event.target.value)}
            aria-invalid={!!error}
            aria-describedby={error ? 'plugin-catalog-url-error' : undefined}
          />
        </InputWrapper>
        {error && (
          <ErrMessage id='plugin-catalog-url-error' role='alert'>
            {error}
          </ErrMessage>
        )}
        <Row gap='0.5rem'>
          <Button type='submit' disabled={value === catalogUrl}>
            Save
          </Button>
          <Button
            type='button'
            subtle
            onClick={() => {
              setPluginCatalogUrl('');
              setValue(defaultPluginCatalogUrl);
              setError('');
            }}
          >
            Reset to default
          </Button>
        </Row>
      </Column>
    </form>
  );
}

const SectionTitle = styled.h3`
  margin: 0;
  font-size: 0.95rem;
  font-weight: 650;
  color: ${p => p.theme.colors.text};
`;

const Description = styled.p`
  font-size: 0.8rem;
  margin: 0;
  color: ${p => p.theme.colors.textLight};
`;
