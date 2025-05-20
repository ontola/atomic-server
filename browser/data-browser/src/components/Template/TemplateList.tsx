import { TemplateListItem } from './TemplateListItem';
import { styled } from 'styled-components';
import { website } from './templates/website';
import type { Template, TemplateFn } from './template';
import { useState } from 'react';
import { ApplyTemplateDialog } from './ApplyTemplateDialog';
import { useSettings } from '../../helpers/AppSettings';

const templates: TemplateFn[] = [website];

export function TemplateList(): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<Template>();
  const { drive } = useSettings();

  return (
    <>
      <List>
        {templates.map(templatefn => {
          const context = {
            driveURL: drive,
          };

          const template = templatefn(context);

          const { id, title, Image } = template;

          return (
            <li key={id}>
              <TemplateListItem
                id={id}
                title={title}
                Image={Image}
                onClick={tmpl => {
                  const newTemplate = templates.find(
                    t => t(context).id === tmpl,
                  );

                  if (!newTemplate) return;

                  setSelectedTemplate(template);
                  setDialogOpen(true);
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
