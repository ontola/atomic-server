import { Checkbox } from '@components/forms/Checkbox';
import { Column } from '@components/Row';
import {
  resolveWriteTargetParent,
  UnresolvedWriteTargetError,
  type DeclaredWriteTarget,
  type JSONValue,
} from '@tomic/react';
import { ResourceInline } from '@views/ResourceInline';
import { useId } from 'react';
import { styled } from 'styled-components';

/**
 * The first write target a config leaves unresolved, if any: the install
 * review can't give the plugin rights on a parent it can't name.
 */
export function unresolvedWriteTarget(
  targets: DeclaredWriteTarget[],
  config: JSONValue | undefined,
): UnresolvedWriteTargetError | undefined {
  for (const target of targets) {
    try {
      resolveWriteTargetParent(target, config);
    } catch (e) {
      if (e instanceof UnresolvedWriteTargetError) return e;
      throw e;
    }
  }

  return undefined;
}

// Wuchale drops a message with nested elements when it sits inside a
// `{condition && (...)}`, so each variant is its own component.

function UnsetParent({ keyName }: { keyName: string }) {
  return (
    <Muted>
      the resource in the config key <code>{keyName}</code>, which is not set
    </Muted>
  );
}

function TargetParent({
  target,
  config,
}: {
  target: DeclaredWriteTarget;
  config: JSONValue | undefined;
}) {
  const problem = unresolvedWriteTarget([target], config);

  if (problem) return <UnsetParent keyName={problem.key} />;

  return <ResourceInline subject={resolveWriteTargetParent(target, config)} />;
}

function NewTarget() {
  return <Pill data-testid='route-write-new'>New</Pill>;
}

function TargetItem({
  target,
  config,
  isNew,
}: {
  target: DeclaredWriteTarget;
  config: JSONValue | undefined;
  isNew: boolean;
}) {
  return (
    <li data-testid={`route-write-target-${target.id}`}>
      <span>
        <code>{target.id}</code>:
      </span>
      <TargetParent target={target} config={config} />
      {isNew && <NewTarget />}
    </li>
  );
}

function UnresolvedNote({ problem }: { problem: UnresolvedWriteTargetError }) {
  return (
    <Alert role='alert' data-testid='route-write-unresolved'>
      Set <code>{problem.key}</code> in the config below to the resource that
      should receive these items, or leave this unchecked.
    </Alert>
  );
}

/**
 * The route grant in the install and update review (design 2.6, D4): whether
 * this plugin may store what other servers send to its endpoints, without a
 * person approving each one. Unchecked unless an earlier review already
 * approved exactly these targets; the design has no default approval.
 */
export function RouteWriteApproval({
  plugin,
  targets,
  newTargets,
  config,
  checked,
  onChange,
}: {
  plugin: string;
  targets: DeclaredWriteTarget[];
  /** Targets an earlier approval doesn't cover; none on a first install. */
  newTargets: DeclaredWriteTarget[];
  config: JSONValue | undefined;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const unresolved = checked
    ? unresolvedWriteTarget(targets, config)
    : undefined;
  const names = targets.map(t => t.id).join(', ');

  return (
    <Column as='section' aria-label='Route writes' gap='0.5rem'>
      <h3>Incoming items</h3>
      <Approval htmlFor={id}>
        <Checkbox
          id={id}
          data-testid='route-write-approval'
          checked={checked}
          onChange={onChange}
        />
        <span>
          Let <strong>{plugin}</strong> add items to <code>{names}</code> when
          other servers send them
        </span>
      </Approval>
      <Targets>
        {targets.map(target => (
          <TargetItem
            key={target.id}
            target={target}
            config={config}
            isNew={newTargets.includes(target)}
          />
        ))}
      </Targets>
      <Muted>
        The plugin gets write rights on these resources, and may only change or
        delete what it added. Revoking or uninstalling it takes the rights back.
        Unchecked, anything sent to these endpoints is refused.
      </Muted>
      {unresolved && <UnresolvedNote problem={unresolved} />}
    </Column>
  );
}

const Approval = styled.label`
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  cursor: pointer;

  input {
    margin-top: 0.25rem;
  }
`;

const Targets = styled.ul`
  margin: 0;
  padding-inline-start: 1.75rem;
  overflow-wrap: anywhere;

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5ch;
    align-items: center;
  }
`;

const Muted = styled.span`
  color: ${p => p.theme.colors.textLight};
`;

const Alert = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;

const Pill = styled.span`
  font-size: 0.8rem;
  padding: 0 0.4rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.warning};
`;
