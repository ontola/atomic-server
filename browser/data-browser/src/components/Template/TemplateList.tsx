import { TemplateListItem } from './TemplateListItem';
import { styled } from 'styled-components';
import { templates, type Template } from './template';
import { useState } from 'react';
import { ApplyTemplateDialog } from './ApplyTemplateDialog';
import { useSettings } from '../../helpers/AppSettings';

export function TemplateList(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template>();
  const { drive } = useSettings();
  const context = {
    driveURL: drive,
  };

  return (
    <>
      <List>
        {templates.map(template => {
          const { id, title, Image } = template;

          return (
            <li key={id}>
              <TemplateListItem
                id={id}
                title={title}
                Image={Image}
                onClick={() => {
                  template.load().then(loadedTemplate => {
                    setSelectedTemplate(loadedTemplate(context));
                    setDialogOpen(true);
                  });
                }}
              />
            </li>
          );
        })}
      </List>
      <ApplyTemplateDialog
        template={selectedTemplate}
        open={dialogOpen}
        bindOpen={setDialogOpen}
      />
    </>
  );
}

const List = styled.ul`
  li {
    list-style: none;
    padding: 0;
    margin: 0;
  }
`;
