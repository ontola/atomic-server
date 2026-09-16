import React, { useState } from 'react';
import { FaChevronRight } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { Collapse } from '@components/Collapse';
import type { AtomicUIMessage } from './types';

const SUMMARY_TAG_RE = /<\/?conversation-summary>/g;

export function extractSummaryTextFromMessage(
  message: AtomicUIMessage,
): string | undefined {
  const textPart = message.parts.find(p => p.type === 'text');

  if (!textPart || textPart.type !== 'text') return undefined;

  return textPart.text.replace(SUMMARY_TAG_RE, '').trim();
}

interface CompactSeparatorWidgetProps {
  summaryText?: string;
}

export const CompactSeparatorWidget: React.FC<CompactSeparatorWidgetProps> = ({
  summaryText,
}) => {
  const [expanded, setExpanded] = useState(false);
  const label = 'Context compacted';

  return (
    <CompactSeparatorContainer data-compact-separator>
      <CompactSeparatorRow
        clickable={!!summaryText}
        onClick={summaryText ? () => setExpanded(e => !e) : undefined}
        title={summaryText ? 'Show summary' : undefined}
      >
        <CompactSeparatorLine />
        <CompactSeparatorLabel>
          {summaryText && (
            <ChevronIcon expanded={expanded}>
              <FaChevronRight />
            </ChevronIcon>
          )}
          <span>{label}</span>
        </CompactSeparatorLabel>
        <CompactSeparatorLine />
      </CompactSeparatorRow>
      {summaryText && (
        <Collapse open={expanded}>
          <SummaryText>{summaryText}</SummaryText>
        </Collapse>
      )}
    </CompactSeparatorContainer>
  );
};

const CompactSeparatorContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  padding-block: var(--space-2);
`;

const CompactSeparatorRow = styled.button<{ clickable: boolean }>`
  appearance: none;
  display: flex;
  align-items: center;
  border: none;
  background: none;
  gap: var(--space-2);
  cursor: ${p => (p.clickable ? 'pointer' : 'default')};

  &:hover > span {
    color: ${p =>
      p.clickable ? 'var(--color-text)' : 'var(--color-text-subtle)'};
  }
`;

const CompactSeparatorLine = styled.div`
  flex: 1;
  height: 1px;
  background-color: var(--color-border);
`;

const CompactSeparatorLabel = styled.span`
  display: flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 0.75rem;
  color: var(--color-text-subtle);
  white-space: nowrap;
  transition: color 0.1s;
`;

const ChevronIcon = styled.span<{ expanded: boolean }>`
  display: inline-flex;
  font-size: 0.65rem;
  transform: rotate(${p => (p.expanded ? '90deg' : '0deg')});
  transition: transform 0.15s ease;
`;

const SummaryText = styled.p`
  font-size: 0.8rem;
  color: var(--color-text-subtle);
  padding: var(--space-2);
  background-color: var(--color-bg-subtle);
  border-radius: var(--radius-md);
  margin: 0;
  line-height: 1.5;
  white-space: pre-wrap;
`;
