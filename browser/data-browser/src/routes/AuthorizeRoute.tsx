import { useEffect, useMemo, useState } from 'react';
import {
  approveAccessRequest,
  authorizeRedirectUrl,
  createAccessRequest,
  denyAccessRequest,
  expandAccessRequestTargets,
  parseAuthorizeQuery,
  useCurrentAgent,
  useResource,
  useStore,
  useTitle,
} from '@tomic/react';
import { createRoute } from '@tanstack/react-router';
import { Button } from '../components/Button';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Column, Row } from '../components/Row';
import { Checkbox } from '../components/forms/Checkbox';
import { ErrorLook } from '../components/ErrorLook';
import { SecretCodeBlock } from '../components/SecretCodeBlock';
import { WarningBlock } from '../components/WarningBlock';
import { AtomicLink } from '../components/AtomicLink';
import { appRoute } from './RootRoutes';
import { pathNames, paths } from './paths';
import { usePersonalDrive } from '../hooks/usePersonalDrive';
import { useSavedDrives } from '../hooks/useSavedDrives';
import { getOrCreateAppKeysFolder } from '../helpers/appKeysFolder';
import { getOrCreateAppKeyRequestsFolder } from '../helpers/appKeyRequestsFolder';
import { styled } from 'styled-components';

export const AuthorizeRoute = createRoute({
  path: pathNames.authorize,
  component: () => <AuthorizePage />,
  getParentRoute: () => appRoute,
});

/**
 * OAuth `/authorize` analog: the app sent the user here with the rights it
 * wants. We persist that as a pending request on the personal drive, then
 * wait for Allow / Deny.
 */
function AuthorizePage() {
  const store = useStore();
  const [agent] = useCurrentAgent();
  const { personalDrive } = usePersonalDrive();
  const [savedDrives] = useSavedDrives();
  const parsed = useMemo(
    () => parseAuthorizeQuery(window.location.search.replace(/^\?/, '')),
    [],
  );

  const workspaces = useMemo(() => {
    const subjects = [
      ...(personalDrive ? [personalDrive] : []),
      ...savedDrives.filter(subject => subject !== personalDrive),
    ];

    return [...new Set(subjects)];
  }, [personalDrive, savedDrives]);

  const [requestSubject, setRequestSubject] = useState<string>();
  const [keysFolder, setKeysFolder] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string>();
  const [grantedAgent, setGrantedAgent] = useState<string>();

  const expanded = parsed.ok
    ? expandAccessRequestTargets(parsed.spec.targets, workspaces)
    : [];

  useEffect(() => {
    setSelected(current => {
      if (current.length === 0) {
        return expanded;
      }

      const still = current.filter(s => expanded.includes(s));

      return still.length > 0 ? still : expanded;
    });
  }, [expanded.join('|')]);

  useEffect(() => {
    if (!parsed.ok || !agent || !personalDrive) {
      return;
    }

    let cancelled = false;

    void (async () => {
      try {
        const [inbox, folder] = await Promise.all([
          getOrCreateAppKeyRequestsFolder(store, personalDrive),
          getOrCreateAppKeysFolder(store, personalDrive),
        ]);

        if (cancelled) {
          return;
        }

        const subject = await createAccessRequest(store, {
          ...parsed.spec,
          parent: inbox,
          drive: personalDrive,
        });

        if (!cancelled) {
          setRequestSubject(subject);
          setKeysFolder(folder);
          setError(undefined);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [parsed, agent, personalDrive, store]);

  async function handleAllow() {
    if (!requestSubject) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      const result = await approveAccessRequest(store, requestSubject, {
        targets: selected,
        parent: keysFolder,
      });
      setGrantedAgent(result.subject);

      if (result.secret) {
        setSecret(result.secret);

        return;
      }

      const spec = parsed.ok ? parsed.spec : undefined;
      const redirect = authorizeRedirectUrl(spec?.redirectUri, {
        agent: result.subject,
        state: spec?.state,
      });

      if (redirect) {
        window.location.assign(redirect);

        return;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeny() {
    if (!requestSubject) {
      return;
    }

    setBusy(true);
    setError(undefined);

    try {
      await denyAccessRequest(store, requestSubject);
      window.location.assign(paths.agentSettings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Main>
      <ContainerNarrow>
        <Column gap='1.25rem'>
          <h1>Authorize an app</h1>
          {!parsed.ok ? (
            <ErrorLook>{parsed.error}</ErrorLook>
          ) : !agent ? (
            <p>
              Sign in first, then return to this page.{' '}
              <AtomicLink path={paths.welcome}>Sign in</AtomicLink>
            </p>
          ) : secret ? (
            <>
              <WarningBlock>
                <WarningBlock.Title>
                  Copy this secret now. You will not see it again.
                </WarningBlock.Title>
                The app did not send a public key, so this session minted the
                keypair. Paste the secret into the app.
              </WarningBlock>
              <SecretCodeBlock content={secret} />
              <Button
                onClick={() => window.location.assign(paths.agentSettings)}
                data-testid='app-key-secret-done'
              >
                I have copied it
              </Button>
            </>
          ) : grantedAgent ? (
            <Column gap='0.75rem'>
              <p>
                Access granted. The app already holds the key — nothing to copy.
              </p>
              <AtomicLink path={paths.agentSettings}>
                Back to App keys
              </AtomicLink>
            </Column>
          ) : (
            <>
              <p>
                <strong>{parsed.spec.name}</strong> wants{' '}
                {parsed.spec.write ? 'read and write' : 'read'} access.
                {parsed.spec.description ? ` ${parsed.spec.description}` : ''}
              </p>
              <Hint>
                A folder or page grant covers that resource and everything
                inside it — not the rest of the workspace. You can uncheck
                anything you do not want to grant.
              </Hint>
              <Column gap='0.4rem'>
                {selected.length === 0 && expanded.length === 0 ? (
                  <p>No workspaces to grant yet.</p>
                ) : (
                  expanded.map(subject => (
                    <TargetCheck
                      key={subject}
                      subject={subject}
                      checked={selected.includes(subject)}
                      onChange={checked =>
                        setSelected(list =>
                          checked
                            ? [...list, subject]
                            : list.filter(s => s !== subject),
                        )
                      }
                    />
                  ))
                )}
              </Column>
              {error && <ErrorLook>{error}</ErrorLook>}
              <Row gap='0.5rem'>
                <Button
                  subtle
                  onClick={() => void handleDeny()}
                  disabled={busy || !requestSubject}
                  data-testid='authorize-deny'
                >
                  Deny
                </Button>
                <Button
                  onClick={() => void handleAllow()}
                  disabled={busy || !requestSubject || selected.length === 0}
                  data-testid='authorize-allow'
                >
                  {busy ? 'Granting…' : 'Allow'}
                </Button>
              </Row>
            </>
          )}
        </Column>
      </ContainerNarrow>
    </Main>
  );
}

function TargetCheck({
  subject,
  checked,
  onChange,
}: {
  subject: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const resource = useResource(subject);
  const [title] = useTitle(resource);

  return (
    <Row gap='0.5rem' align='center'>
      <Checkbox
        checked={checked}
        onChange={onChange}
        aria-label={title || subject}
      />
      <span>{title || subject}</span>
    </Row>
  );
}

const Hint = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9em;
`;
