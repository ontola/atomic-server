import {
  core,
  dataBrowser,
  unknownSubject,
  useArray,
  useResource,
  useStore,
  useString,
  useValue,
  type AggregateFunction,
  type JSONValue,
  type Property,
} from '@tomic/react';
import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../../components/Dialog';
import { Button } from '../../components/Button';
import { InputWrapper, InputStyled } from '../../components/forms/InputStyles';
import { ResourceSelector } from '../../components/forms/ResourceSelector/ResourceSelector';
import {
  AGGREGATE_FUNCTIONS,
  AGGREGATE_FUNCTION_LABELS,
  isGroupableProperty,
  propertiesForFunction,
  functionsForDerived,
  defaultGranularity,
  granularityApplies,
  type GroupGranularity,
} from '../TablePage/tableAggregates';
import { parseDerivedColumnSpecs } from '../TablePage/derivedColumns';
import {
  BLOCK_KIND_LABELS,
  parseBlockAggregate,
  parseBlockChartSpec,
  type BlockKind,
} from './dashboardBlocks';
import { useClassProperties } from './useClassProperties';
import {
  QuickAddFields,
  draftFromSpec,
  specFromDraft,
  type QuickAddDraft,
} from '../TablePage/QuickAddFields';
import { parseQuickAdd } from '../TablePage/quickAdd';

interface Props {
  blockSubject: string;
  show: boolean;
  bindShow: (show: boolean) => void;
}

/**
 * The other half of `create_dashboard`: everything the tool can write about a
 * block, a person can change here. A capability that only the assistant can
 * configure leaves its owner stuck with whatever it guessed.
 */
export function BlockConfigDialog({
  blockSubject,
  show,
  bindShow,
}: Props): JSX.Element {
  const store = useStore();
  const block = useResource(blockSubject);
  const [dialogProps, showDialog, hideDialog, isOpen] = useDialog({
    bindShow,
  });

  const [kind] = useString(block, dataBrowser.properties.blockKind);
  const [storedName] = useString(block, core.properties.name);
  const [storedSource] = useString(block, dataBrowser.properties.blockSource);
  const [storedView] = useString(block, dataBrowser.properties.blockView);
  const [storedDescription] = useString(block, core.properties.description);
  const [storedAggregate] = useValue(
    block,
    dataBrowser.properties.blockAggregate,
  );
  const [storedChart] = useValue(block, dataBrowser.properties.blockChartSpec);
  const [storedQuickAdd] = useValue(
    block,
    dataBrowser.properties.blockQuickAdd,
  );

  const blockKind = (kind ?? 'text') as BlockKind;

  // Local draft state: the dialog is a form, so nothing is written until Save —
  // otherwise picking a table would immediately break a block whose aggregate
  // still names the previous table's property.
  const [name, setName] = useState('');
  const [source, setSource] = useState<string | undefined>(undefined);
  const [view, setView] = useState<string | undefined>(undefined);
  const [text, setText] = useState('');
  const [fn, setFn] = useState<AggregateFunction>('count');
  const [target, setTarget] = useState('');
  const [chartField, setChartField] = useState('');
  const [granularity, setGranularity] = useState<GroupGranularity>('exact');
  const [quickAdd, setQuickAdd] = useState<QuickAddDraft>(() =>
    draftFromSpec(undefined),
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const aggregate = parseBlockAggregate(storedAggregate as JSONValue);
    const chart = parseBlockChartSpec(storedChart as JSONValue);

    setName(storedName ?? '');
    setSource(storedSource);
    setView(storedView);
    setText(storedDescription ?? '');
    setFn(aggregate?.function ?? 'count');
    setTarget(
      aggregate?.derived
        ? `derived:${aggregate.derived}`
        : (aggregate?.property ?? ''),
    );
    setChartField(chart?.field ?? '');
    setGranularity(chart?.granularity ?? 'exact');
    setQuickAdd(draftFromSpec(parseQuickAdd(storedQuickAdd as JSONValue)));
    // Deliberately only on open: re-syncing while the dialog is up would
    // overwrite what is being typed whenever a commit lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const sourceResource = useResource(source ?? unknownSubject);
  const [classSubject] = useString(sourceResource, core.properties.classtype);
  const [viewSubjects] = useArray(
    sourceResource,
    dataBrowser.properties.tableViews,
  );
  const classProperties = useClassProperties(classSubject);

  const viewResource = useResource(view ?? unknownSubject);
  const [storedDerived] = useValue(
    viewResource,
    dataBrowser.properties.viewDerivedColumns,
  );
  const derivedColumns = parseDerivedColumnSpecs(storedDerived);

  /**
   * The offered columns, plus whatever is already stored even when it would not
   * be offered — a chart grouped by a text column, say, which the breakdown rule
   * deliberately keeps out of the menu. Dropping it from the list would make
   * merely opening this dialog and pressing Save destroy working configuration.
   */
  const withStored = (offered: Property[], stored: string): Property[] =>
    stored && !offered.some(p => p.subject === stored)
      ? [...offered, ...classProperties.filter(p => p.subject === stored)]
      : offered;

  const measurable: Property[] = withStored(
    fn === 'count' ? [] : propertiesForFunction(classProperties, fn),
    target.startsWith('derived:') ? '' : target,
  );
  const derivedForFn = derivedColumns.filter(spec =>
    functionsForDerived(spec).includes(fn),
  );
  const groupable = withStored(
    classProperties.filter(isGroupableProperty),
    chartField,
  );
  const chartProperty = classProperties.find(p => p.subject === chartField);

  const save = async () => {
    await block.set(core.properties.name, name, false);

    if (blockKind === 'text') {
      await block.set(core.properties.description, text, false);
    } else {
      await block.set(dataBrowser.properties.blockSource, source ?? '', false);
      await block.set(dataBrowser.properties.blockView, view ?? '', false);
    }

    if (blockKind === 'stat' || blockKind === 'chart') {
      const derived = target.startsWith('derived:')
        ? target.slice('derived:'.length)
        : undefined;
      const aggregate = {
        function: fn,
        ...(fn === 'count' ? {} : derived ? { derived } : { property: target }),
      };
      // Validated on purpose (no `false`): the property fetch it triggers is
      // what puts the Property in the store, and that is the only way the JSON
      // datatype tag gets recorded — without it this object is stored as a JSON
      // *string* and read back as one.
      await block.set(
        dataBrowser.properties.blockAggregate,
        aggregate as unknown as never,
      );
    }

    if (blockKind === 'create') {
      // Same shape a View's `view-quick-add` holds, written through the same
      // form — one capability, one representation.
      await block.set(
        dataBrowser.properties.blockQuickAdd,
        specFromDraft(quickAdd) as unknown as never,
      );
    }

    if (blockKind === 'chart') {
      await block.set(dataBrowser.properties.blockChartSpec, {
        mark: 'bar',
        field: chartField,
        granularity: granularityApplies(chartProperty) ? granularity : 'exact',
      } as unknown as never);
    }

    await block.save();
    hideDialog();
  };

  useEffect(() => {
    if (show) {
      showDialog();
    }
  }, [show, showDialog]);

  return (
    <Dialog {...dialogProps}>
      <DialogTitle>
        <h2>Configure {BLOCK_KIND_LABELS[blockKind].toLowerCase()}</h2>
      </DialogTitle>
      <DialogContent>
        <Fields>
          <Field>
            <label htmlFor='block-name'>Title</label>
            <InputWrapper>
              <InputStyled
                id='block-name'
                data-testid='block-name'
                value={name}
                placeholder='What this shows'
                onChange={e => setName(e.target.value)}
              />
            </InputWrapper>
          </Field>

          {blockKind === 'text' ? (
            <Field>
              <label htmlFor='block-text'>Text</label>
              <InputWrapper>
                <TextArea
                  id='block-text'
                  data-testid='block-text'
                  value={text}
                  rows={5}
                  onChange={e => setText(e.target.value)}
                />
              </InputWrapper>
            </Field>
          ) : (
            <>
              <Field>
                <label htmlFor='block-source'>Table</label>
                <ResourceSelector
                  id='block-source'
                  isA={dataBrowser.classes.table}
                  value={source}
                  setSubject={next => {
                    setSource(next);
                    // The view, the measured property and the grouping all
                    // belong to the previous table; keeping them would ask the
                    // store to sum a property this class doesn't have.
                    setView(undefined);
                    setTarget('');
                    setChartField('');
                  }}
                  hideCreateOption
                />
              </Field>
              <Field>
                <label htmlFor='block-view'>Rows</label>
                <StyledSelect
                  id='block-view'
                  data-testid='block-view'
                  value={view ?? ''}
                  onChange={e => setView(e.target.value || undefined)}
                >
                  <option value=''>Every row</option>
                  {(viewSubjects as string[]).map(subject => (
                    <ViewOption key={subject} subject={subject} />
                  ))}
                </StyledSelect>
              </Field>
            </>
          )}

          {blockKind === 'create' && (
            <QuickAddFields
              draft={quickAdd}
              onChange={setQuickAdd}
              classProperties={classProperties}
            />
          )}

          {(blockKind === 'stat' || blockKind === 'chart') && (
            <>
              <Field>
                <label htmlFor='block-function'>Measure</label>
                <StyledSelect
                  id='block-function'
                  data-testid='block-function'
                  value={fn}
                  onChange={e => {
                    setFn(e.target.value as AggregateFunction);
                    setTarget('');
                  }}
                >
                  {AGGREGATE_FUNCTIONS.map(f => (
                    <option key={f} value={f}>
                      {AGGREGATE_FUNCTION_LABELS[f]}
                    </option>
                  ))}
                </StyledSelect>
              </Field>
              {fn !== 'count' && (
                <Field>
                  <label htmlFor='block-target'>Of</label>
                  <StyledSelect
                    id='block-target'
                    data-testid='block-target'
                    value={target}
                    onChange={e => setTarget(e.target.value)}
                  >
                    <option value=''>Pick a column…</option>
                    {measurable.map(p => (
                      <option key={p.subject} value={p.subject}>
                        {p.shortname}
                      </option>
                    ))}
                    {derivedForFn.map(spec => (
                      <option key={spec.id} value={`derived:${spec.id}`}>
                        {spec.label}
                      </option>
                    ))}
                  </StyledSelect>
                </Field>
              )}
            </>
          )}

          {blockKind === 'chart' && (
            <>
              <Field>
                <label htmlFor='block-chart-field'>One bar per</label>
                <StyledSelect
                  id='block-chart-field'
                  data-testid='block-chart-field'
                  value={chartField}
                  onChange={e => {
                    setChartField(e.target.value);
                    const property = classProperties.find(
                      p => p.subject === e.target.value,
                    );
                    setGranularity(defaultGranularity(property));
                  }}
                >
                  <option value=''>Pick a column…</option>
                  {groupable.map(p => (
                    <option key={p.subject} value={p.subject}>
                      {p.shortname}
                    </option>
                  ))}
                </StyledSelect>
              </Field>
              {granularityApplies(chartProperty) && (
                <Field>
                  <label htmlFor='block-granularity'>Bucket</label>
                  <StyledSelect
                    id='block-granularity'
                    data-testid='block-granularity'
                    value={granularity}
                    onChange={e =>
                      setGranularity(e.target.value as GroupGranularity)
                    }
                  >
                    <option value='day'>Per day</option>
                    <option value='month'>Per month</option>
                    <option value='exact'>Each value</option>
                  </StyledSelect>
                </Field>
              )}
            </>
          )}
        </Fields>
      </DialogContent>
      <DialogActions>
        <Button subtle onClick={() => hideDialog()}>
          Cancel
        </Button>
        <Button
          data-testid='block-save'
          onClick={() => {
            void save().catch(error => {
              store.notifyError(error as Error);
            });
          }}
        >
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A view's name, for the "Rows" picker. */
function ViewOption({ subject }: { subject: string }): JSX.Element {
  const view = useResource(subject);
  const [name] = useString(view, core.properties.name);

  return <option value={subject}>{name ?? 'View'}</option>;
}

const Fields = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(2)};
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size(1)};

  label {
    font-size: 0.85rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const StyledSelect = styled.select`
  padding: 0.4rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
`;

const TextArea = styled.textarea`
  border: none;
  background: transparent;
  color: ${p => p.theme.colors.text};
  padding: 0.4rem;
  width: 100%;
  resize: vertical;
  font-family: inherit;
`;
