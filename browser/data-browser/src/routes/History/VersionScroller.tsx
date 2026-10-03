import { useId, Fragment, type JSX } from 'react';
import { GroupedVersions } from './HistoryViewProps';
import { Version } from '@tomic/react';
import { styled } from 'styled-components';
import { Column } from '../../components/Row';
import { VersionButton } from './VersionButton';
import { IconButton } from '../../components/IconButton/IconButton';
import { FaChevronLeft, FaChevronRight } from 'react-icons/fa6';

interface VersionScrollerProps {
  groupedVersions: GroupedVersions;
  selectedVersion: Version | undefined;
  onSelectVersion: (version: Version) => void;
  onNextItem?: () => void;
  onPreviousItem?: () => void;
  title: string;
  persistSelection?: boolean;
  className?: string;
}

export function VersionScroller({
  groupedVersions,
  selectedVersion,
  title,
  className,
  persistSelection = false,
  onNextItem,
  onPreviousItem,
  onSelectVersion,
}: VersionScrollerProps): JSX.Element {
  const scrollerTitleId = useId();

  return (
    <ScrollerSection className={className}>
      <ScrollerTitle id={scrollerTitleId}>{title}</ScrollerTitle>
      <Scroller aria-labelledby={scrollerTitleId}>
        <Column>
          {Object.entries(groupedVersions).map(([key, group]) => (
            <Fragment key={key}>
              <GroupHeading>{key}</GroupHeading>
              {[...group].map(version => (
                <VersionButton
                  onClick={() => onSelectVersion(version)}
                  version={version}
                  key={`${version.peer}-${version.frontiers[0]?.counter ?? 0}`}
                  selected={persistSelection && selectedVersion === version}
                />
              ))}
            </Fragment>
          ))}
        </Column>
      </Scroller>
      {onPreviousItem && onPreviousItem && (
        <ButtonWrapper>
          <IconButton
            color='main'
            title='Previous item'
            onClick={onPreviousItem}
          >
            <FaChevronLeft />
          </IconButton>
          <IconButton title='Next item' color='main' onClick={onNextItem}>
            <FaChevronRight />
          </IconButton>
        </ButtonWrapper>
      )}
    </ScrollerSection>
  );
}

const ScrollerSection = styled.section`
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  min-width: 12rem;
  max-width: 20rem;
  display: grid;
  grid-template-rows: auto 1fr auto;
  position: relative;
`;

const Scroller = styled.div`
  padding: 1rem;
  overflow: auto;
`;

const ScrollerTitle = styled.h2`
  padding: ${p => p.theme.margin}rem;
  margin-bottom: 0;
  text-align: center;
`;

const ButtonWrapper = styled.div`
  padding: ${p => p.theme.margin}rem;
  display: flex;
  justify-content: space-between;
`;
const GroupHeading = styled.h3`
  &::before {
    content: '';
    display: block;
    height: 1px;
    background-color: ${p => p.theme.colors.bg2};
  }
  &::after {
    content: '';
    display: block;
    height: 1px;
    background-color: ${p => p.theme.colors.bg2};
  }
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 0.5rem;
  text-align: center;
  color: ${p => p.theme.colors.textLight};
`;
