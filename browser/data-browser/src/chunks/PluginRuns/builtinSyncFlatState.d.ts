export type FieldEvidence =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'absent' };
export interface DurableSyncRun {
  ruleSubject: string;
  ruleKey: string;
  runId: string;
  generation: string;
  startOrder: number;
  complete: boolean;
  entityKeys: string[];
}
export interface DurableEntityObservation {
  entityKey: string;
  raw?: Record<string, unknown>;
  ruleKey: string;
  runId: string;
  generation: string;
  representationKey: string;
  partitionKey: string;
  fields: Record<string, FieldEvidence>;
}
export function reduceFlatState(input: {
  runs: DurableSyncRun[];
  observations: DurableEntityObservation[];
}): Record<
  string,
  {
    values: Record<string, unknown>;
    raw?: Record<string, unknown>;
    cleared: string[];
    memberships: string[];
  }
>;
