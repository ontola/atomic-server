import { useEffect, useState, type JSX } from 'react';
import { styled } from 'styled-components';
import toast from 'react-hot-toast';
import QRCode from 'qrcode';
import { FaArrowUpRightFromSquare, FaCopy } from 'react-icons/fa6';
import { Column, Row } from '@components/Row';

/** A link as a QR code, with Copy and Open. Used by the share dialogs. */
export function ShareLink({
  url,
  qrAlt,
}: {
  url: string;
  qrAlt: string;
}): JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;

    QRCode.toDataURL(url, { margin: 1, width: 180 }).then(dataUrl => {
      if (!cancelled) setQrDataUrl(dataUrl);
    });

    return () => {
      cancelled = true;
    };
  }, [url]);

  const copyLink = () => {
    navigator.clipboard.writeText(url);
    toast.success('Link copied to clipboard');
  };

  return (
    <Column gap='0.75rem' align='center'>
      {qrDataUrl && <QrImage src={qrDataUrl} alt={qrAlt} />}
      <LinkText title={url}>{url}</LinkText>
      <Row gap='0.5rem'>
        <PanelButton type='button' onClick={copyLink}>
          <FaCopy /> Copy link
        </PanelButton>
        <PanelLink href={url} target='_blank' rel='noreferrer'>
          <FaArrowUpRightFromSquare /> Open
        </PanelLink>
      </Row>
    </Column>
  );
}

const QrImage = styled.img`
  width: 10rem;
  height: 10rem;
  border-radius: ${p => p.theme.radius};
`;

const LinkText = styled.span`
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: ${p => p.theme.colors.textLight};
`;

const PanelButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 1.85rem;
  padding: 0 0.6rem;
  border: none;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.text};
  cursor: pointer;

  &:hover {
    background-color: ${p => p.theme.colors.bg2};
  }
`;

const PanelLink = styled.a`
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  height: 1.85rem;
  padding: 0 0.6rem;
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg1};
  color: ${p => p.theme.colors.text};
  text-decoration: none;

  &:hover {
    background-color: ${p => p.theme.colors.bg2};
  }
`;
