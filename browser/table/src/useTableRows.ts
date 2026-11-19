import { useEffect, useState } from 'react';
import {
  readTableRow,
  tableRowCount,
  type TableRowSource,
  type IndexedTableRows,
} from './rows.js';

const EMPTY_SUBJECTS: string[] = [];

export function useTableRowSubject(source: TableRowSource, index: number) {
  const count = tableRowCount(source);
  const windowSubjects = 'subjects' in source ? source.subjects : undefined;
  const [state, setState] = useState<{
    source: TableRowSource;
    index: number;
    count: number;
    windowSubjects?: readonly string[];
    subject?: string;
    error?: unknown;
  }>();
  useEffect(() => {
    let active = true;
    void readTableRow(source, index).then(
      subject => {
        if (active) setState({ source, index, count, windowSubjects, subject });
      },
      error => {
        if (active) setState({ source, index, count, windowSubjects, error });
      },
    );

    return () => {
      active = false;
    };
  }, [source, index, count, windowSubjects]);
  if (
    state?.source !== source ||
    state.index !== index ||
    state.count !== count ||
    state.windowSubjects !== windowSubjects
  )
    return { subject: undefined, loading: true, error: undefined };

  return { subject: state.subject, loading: false, error: state.error };
}

/** Whole-result views must explicitly require an indexed source. */
export function useTableRowSubjects(source: IndexedTableRows) {
  const count = source.totalMembers;
  const [state, setState] = useState<{
    source: IndexedTableRows;
    count: number;
    subjects: string[];
    error?: unknown;
  }>();
  useEffect(() => {
    let active = true;
    void source.getAllMembers().then(
      subjects => {
        if (active) setState({ source, count, subjects });
      },
      error => {
        if (active) setState({ source, count, subjects: [], error });
      },
    );

    return () => {
      active = false;
    };
  }, [source, count]);
  if (state?.source !== source || state.count !== count)
    return { subjects: EMPTY_SUBJECTS, loading: true, error: undefined };

  return { subjects: state.subjects, loading: false, error: state.error };
}
