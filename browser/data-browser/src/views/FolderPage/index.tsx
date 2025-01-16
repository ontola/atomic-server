import {
  classes,
  useCanWrite,
  useResources,
  type DataBrowser,
} from '@tomic/react';
import { useMemo } from 'react';
import { styled } from 'styled-components';
import { EditableTitle } from '../../components/EditableTitle';
import { FileDropZone } from '../../components/forms/FileDropzone/FileDropzone';
import { useNewRoute } from '../../helpers/useNewRoute';
import { ResourcePageProps } from '../ResourcePage';
import { DisplayStyleButton } from './DisplayStyleButton';
import { GridView } from './GridView';
import { ListView } from './ListView';
import { useLocalStorage } from '../../hooks/useLocalStorage';
import { TagBar } from '../../components/Tag/TagBar';
import { Column, Row } from '../../components/Row';

type PreferredFolderStyles = Record<string, string>;

const viewMap = new Map([
  [classes.displayStyles.list, ListView],
  [classes.displayStyles.grid, GridView],
]);

const displayStyleStorageKey = 'folderDisplayPrefs';

const useDisplayStyle = (
  subject: string,
): [
  preferredStyle: string | undefined,
  setPreferredStyle: (style: string) => void,
] => {
  const [preferredStyles, setPreferredStyles] =
    useLocalStorage<PreferredFolderStyles>(displayStyleStorageKey, {});

  const setPreferredStyle = (style: string) => {
    setPreferredStyles({ ...preferredStyles, [subject]: style });
  };

  return [preferredStyles[subject], setPreferredStyle];
};

export function FolderPage({
  resource,
}: ResourcePageProps<DataBrowser.Folder>) {
  const [preferedDisplayStyle, setPreferedDisplayStyle] = useDisplayStyle(
    resource.subject,
  );

  const displayStyle = preferedDisplayStyle ?? resource.props.displayStyle;

  const View = useMemo(
    () => viewMap.get(displayStyle!) ?? ListView,
    [displayStyle],
  );

  const subResources = useResources(resource.props.subResources);
  const navigateToNewRoute = useNewRoute(resource.subject);
  const canEdit = useCanWrite(resource);

  return (
    <FullPageWrapper view={displayStyle!}>
      <Column>
        <div>
          <TitleBarInner justify='space-between'>
            <EditableTitle resource={resource} />
            <DisplayStyleButton
              onClick={setPreferedDisplayStyle}
              displayStyle={displayStyle}
            />
          </TitleBarInner>
        </div>
        <TagBar resource={resource} />
        <Wrapper>
          <FileDropZone parentResource={resource}>
            <View
              subResources={subResources}
              onNewClick={navigateToNewRoute}
              showNewButton={canEdit!}
            />
          </FileDropZone>
        </Wrapper>
      </Column>
    </FullPageWrapper>
  );
}

const TitleBarInner = styled(Row)`
  width: var(--container-width);
  margin-inline: auto;

  input {
    margin-bottom: 0;
  }
`;

const Wrapper = styled.div`
  width: 100%;
  flex: 1;
`;

interface FullPageWrapperProps {
  view: string;
}

const FullPageWrapper = styled.div<FullPageWrapperProps>`
  --container-width: min(1300px, 100%);
  min-height: ${p => p.theme.heights.fullPage};
  display: flex;
  flex-direction: column;
  padding: ${p => p.theme.size()};
  padding-bottom: ${p => p.theme.heights.floatingSearchBarPadding};
`;
