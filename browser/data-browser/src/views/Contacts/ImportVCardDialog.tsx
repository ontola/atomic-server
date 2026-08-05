import { useCallback, useEffect, useState, type FC, type JSX } from 'react';
import { useDropzone } from 'react-dropzone';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { useStore } from '@tomic/react';
import { FaFileImport } from 'react-icons/fa6';
import {
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  useDialog,
} from '../../components/Dialog';
import { Button } from '../../components/Button';
import { Column, Row } from '../../components/Row';
import { parseVCardDocument, type ParsedVCard } from './vcf';
import { importVCards } from './importVCards';

type ImportVCardDialogProps = {
  addressBook: string;
  show: boolean;
  onClose: () => void;
  onImported?: () => void;
};

export const ImportVCardDialog: FC<ImportVCardDialogProps> = ({
  addressBook,
  show: shouldShow,
  onClose,
  onImported,
}): JSX.Element => {
  const store = useStore();
  const [cards, setCards] = useState<ParsedVCard[]>([]);
  const [fileName, setFileName] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();

  const [dialogProps, show, hide, isOpen] = useDialog({
    onCancel: () => {
      setCards([]);
      setFileName(undefined);
      setError(undefined);
      onClose();
    },
  });

  useEffect(() => {
    if (shouldShow) {
      show();
    }
  }, [shouldShow, show]);

  const onDrop = useCallback(async (accepted: File[]) => {
    const file = accepted[0];

    if (!file) {
      return;
    }

    setError(undefined);
    setFileName(file.name);

    try {
      const text = await file.text();
      const parsed = parseVCardDocument(text);

      if (parsed.length === 0) {
        setCards([]);
        setError('No contacts found in this file.');
        return;
      }

      setCards(parsed);
    } catch (e) {
      setCards([]);
      setError(e instanceof Error ? e.message : 'Failed to read file');
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/vcard': ['.vcf', '.vcard'],
      'text/x-vcard': ['.vcf', '.vcard'],
      'text/plain': ['.vcf', '.vcard'],
    },
    multiple: false,
  });

  const handleImport = async () => {
    setImporting(true);

    try {
      const result = await importVCards(store, addressBook, cards);
      toast.success(
        `Imported ${result.created} contact${result.created === 1 ? '' : 's'}` +
          (result.updated > 0 ? `, updated ${result.updated}` : ''),
      );
      setCards([]);
      setFileName(undefined);
      hide();
      onClose();
      onImported?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Import failed');
    }

    setImporting(false);
  };

  if (!isOpen) {
    return <></>;
  }

  return (
    <Dialog {...dialogProps} width='32rem'>
      <DialogTitle>
        <h1>Import vCard</h1>
      </DialogTitle>
      <DialogContent>
        <Column gap='1rem'>
          <Hint>
            Export contacts from Google Contacts, iCloud, or Microsoft as a
            `.vcf` file, then drop it here.
          </Hint>
          <DropZone {...getRootProps()} $active={isDragActive}>
            <input {...getInputProps()} />
            <FaFileImport size='1.5rem' />
            <span>
              {isDragActive
                ? 'Drop vCard here…'
                : fileName
                  ? fileName
                  : 'Drop a .vcf file, or click to browse'}
            </span>
          </DropZone>
          {error && <ErrorText>{error}</ErrorText>}
          {cards.length > 0 && (
            <Preview>
              <strong>
                {cards.length} contact{cards.length === 1 ? '' : 's'} ready
              </strong>
              <ul>
                {cards.slice(0, 8).map((card, i) => (
                  <li key={`${card.uid ?? card.name}-${i}`}>
                    {card.name}
                    {card.email ? ` · ${card.email}` : ''}
                  </li>
                ))}
                {cards.length > 8 && <li>…and {cards.length - 8} more</li>}
              </ul>
            </Preview>
          )}
        </Column>
      </DialogContent>
      <DialogActions>
        <Row gap='0.5rem' justify='flex-end'>
          <Button subtle onClick={() => hide()}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={cards.length === 0 || importing}
            loading={importing ? 'Importing…' : undefined}
          >
            Import
          </Button>
        </Row>
      </DialogActions>
    </Dialog>
  );
};

const Hint = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.textLight};
  font-size: 0.95rem;
`;

const DropZone = styled.div<{ $active: boolean }>`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: ${p => p.theme.size(2)};
  padding: ${p => p.theme.size(6)};
  border: 2px dashed
    ${p => (p.$active ? p.theme.colors.main : p.theme.colors.bg2)};
  border-radius: ${p => p.theme.radius};
  background: ${p => (p.$active ? p.theme.colors.bg1 : p.theme.colors.bg)};
  color: ${p => p.theme.colors.textLight};
  cursor: pointer;
  text-align: center;

  &:hover {
    border-color: ${p => p.theme.colors.main};
  }
`;

const Preview = styled.div`
  font-size: 0.9rem;

  ul {
    margin: ${p => p.theme.size(2)} 0 0;
    padding-inline-start: 1.2rem;
    color: ${p => p.theme.colors.textLight};
  }
`;

const ErrorText = styled.p`
  margin: 0;
  color: ${p => p.theme.colors.alert};
`;
