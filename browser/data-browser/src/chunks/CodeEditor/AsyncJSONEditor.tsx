import CodeMirror, {
  type BasicSetupOptions,
  type EditorView,
  type ReactCodeMirrorRef,
} from '@uiw/react-codemirror';
import { githubLight, githubDark } from '@uiw/codemirror-theme-github';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, type Diagnostic } from '@codemirror/lint';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { styled, useTheme } from 'styled-components';

export interface JSONEditorProps {
  labelId?: string;
  initialValue?: string;
  showErrorStyling?: boolean;
  required?: boolean;
  maxWidth?: string;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  onValidationChange?: (isValid: boolean) => void;
  onBlur?: () => void;
}

const basicSetup: BasicSetupOptions = {
  lineNumbers: false,
  foldGutter: false,
  highlightActiveLine: true,
  indentOnInput: true,
};

/**
 * ASYNC COMPONENT DO NOT IMPORT DIRECTLY, USE {@link JSONEditor.tsx}.
 */
const AsyncJSONEditor: React.FC<JSONEditorProps> = ({
  labelId,
  initialValue,
  showErrorStyling,
  required,
  maxWidth,
  autoFocus,
  onChange,
  onValidationChange,
  onBlur,
}) => {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const theme = useTheme();
  const [value, setValue] = useState(initialValue ?? '');
  const latestDiagnostics = useRef<Diagnostic[]>([]);
  // We need to use callback because the compiler can't optimize the CodeMirror component.
  const handleChange = useCallback(
    (val: string) => {
      setValue(val);
      onChange(val);
    },
    [onChange],
  );

  // Wrap jsonParseLinter so we can tap into diagnostics
  const validationLinter = useMemo(() => {
    const delegate = jsonParseLinter();

    return (view: EditorView) => {
      const isEmpty = view.state.doc.length === 0;
      let diagnostics = delegate(view);

      if (!required && isEmpty) {
        diagnostics = [];
      }

      // Compare the diagnostics so we don't call the onValidationChange callback unnecessarily.
      const prev = latestDiagnostics.current;
      const changed =
        diagnostics.length !== prev.length ||
        diagnostics.some(
          (d, i) => d.from !== prev[i]?.from || d.message !== prev[i]?.message,
        );

      if (changed) {
        latestDiagnostics.current = diagnostics;
        onValidationChange?.(diagnostics.length === 0);
      }

      return diagnostics;
    };
  }, [onValidationChange, required]);

  const extensions = useMemo(
    () => [json(), linter(validationLinter)],
    [validationLinter],
  );

  useEffect(() => {
    // The actual editor is not mounted immediately so we need to wait a cycle.
    requestAnimationFrame(() => {
      if (editorRef.current?.editor && labelId) {
        const realEditor =
          editorRef.current.editor.querySelector('.cm-content');

        if (!realEditor) {
          return;
        }

        realEditor.setAttribute('aria-labelledby', labelId);
      }
    });
  }, [labelId]);

  return (
    <CodeEditorWrapper
      onBlur={() => onBlur?.()}
      className={showErrorStyling ? 'json-editor__error' : ''}
    >
      <CodeMirror
        ref={editorRef}
        autoFocus={autoFocus}
        value={value}
        onChange={handleChange}
        placeholder='Enter valid JSON...'
        // We disable tab indenting because that would mess with accessibility/keyboard navigation.
        indentWithTab={false}
        theme={theme.darkMode ? githubDark : githubLight}
        minHeight='150px'
        maxHeight='40rem'
        maxWidth={maxWidth ?? '100%'}
        basicSetup={basicSetup}
        extensions={extensions}
      />
    </CodeEditorWrapper>
  );
};

export default AsyncJSONEditor;

const CodeEditorWrapper = styled.div`
  display: contents;

  &.json-editor__error .cm-editor {
    border-color: ${p => p.theme.colors.alert} !important;
  }

  & .cm-editor {
    border: 1px solid ${p => p.theme.colors.bg2};
    border-radius: ${p => p.theme.radius};
    /* padding: ${p => p.theme.size(2)}; */
    outline: none;

    &:focus-within {
      border-color: ${p => p.theme.colors.main};
    }
  }
`;
