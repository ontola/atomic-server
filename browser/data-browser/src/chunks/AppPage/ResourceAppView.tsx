import { useDriveApps } from './useDriveApps';
import { useEffect, useState } from 'react';
import {
  findSchema,
  pluginSchema,
  resolveResourceAppView,
  resolveDefaultResourceAppView,
} from '@tomic/lib';
import { useStore, useString, type Resource } from '@tomic/react';
import { styled } from 'styled-components';
import { AppFrame } from './AppFrame';

export function useResourceAppView(
  resource: Resource,
  drive: string | undefined,
) {
  const store = useStore();
  const { apps } = useDriveApps(drive);
  const candidates = JSON.stringify(
    apps.map(app => ({
      subject: app.subject,
      resourceRenders: app.resourceRenders,
    })),
  );
  const [property, setProperty] = useState<{
    drive: string;
    subject?: string;
  }>();
  useEffect(() => {
    let active = true;
    if (drive)
      findSchema(store, drive, pluginSchema()).then(
        schema => {
          if (active)
            setProperty({
              drive,
              subject: schema.properties?.['app-resource-view'],
            });
        },
        () => {
          if (active) setProperty({ drive });
        },
      );

    return () => {
      active = false;
    };
  }, [store, drive, resource.subject]);
  const [binding] = useString(
    resource,
    property && property.drive === drive ? (property.subject ?? '') : '',
  );
  const [resolved, setResolved] = useState<{ binding: string; app?: string }>();
  useEffect(() => {
    let active = true;

    if (drive && binding) {
      resolveResourceAppView(store, drive, binding).then(
        app => {
          if (active) setResolved({ binding, app });
        },
        () => {
          if (active) setResolved({ binding });
        },
      );
    }

    return () => {
      active = false;
    };
  }, [store, drive, binding]);
  const [fallback, setFallback] = useState<{
    subject: string;
    candidates: string;
    app?: string;
  }>();
  useEffect(() => {
    let active = true;
    if (drive && !binding)
      resolveDefaultResourceAppView(
        store,
        drive,
        resource.subject,
        JSON.parse(candidates),
      ).then(
        app => {
          if (active)
            setFallback({ subject: resource.subject, candidates, app });
        },
        () => {
          if (active) setFallback({ subject: resource.subject, candidates });
        },
      );

    return () => {
      active = false;
    };
  }, [store, drive, resource.subject, binding, candidates]);
  if (binding) return resolved?.binding === binding ? resolved.app : undefined;

  return fallback?.subject === resource.subject &&
    fallback?.candidates === candidates
    ? fallback.app
    : undefined;
}

/** Resource context deliberately omits table/view props and their write grants. */
export function ResourceAppView({
  app,
  drive,
  resource,
}: {
  app: string;
  drive: string;
  resource: string;
}) {
  return (
    <Wrapper>
      <AppFrame app={app} drive={drive} resource={resource} />
    </Wrapper>
  );
}

const Wrapper = styled.div`
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: ${p => p.theme.size()};
`;
