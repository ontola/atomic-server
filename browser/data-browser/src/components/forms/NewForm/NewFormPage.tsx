import { useResource } from '@tomic/react';
import { ResourceForm } from '../ResourceForm';
import { NewFormTitle } from './NewFormTitle';
import { SubjectField } from './SubjectField';
import { useNewForm } from './useNewForm';
import { Column } from '../../Row';

import type { JSX } from 'react';
import { useSearch } from '@tanstack/react-router';
import { paths } from '../../../routes/paths';
import { NewRoute } from '../../../routes/NewResource/NewRoute';

export interface NewFormProps {
  classSubject: string;
}

/** Fullpage Form for instantiating a new Resource from some Class */
export const NewFormFullPage = ({
  classSubject,
}: NewFormProps): JSX.Element => {
  const klass = useResource(classSubject);
  const { parent, newSubject: subject } = useSearch({ strict: false });

  const navigate = NewRoute.useNavigate();

  const setSubject = (x: string) => {
    navigate({
      to: paths.new,
      search: prev => ({ ...prev, newSubject: x }),
      replace: true,
    });
  };

  const { initialized, subjectErr, subjectValue, setSubjectValue, resource } =
    useNewForm({
      klass,
      setSubject,
      initialSubject: subject,
      parent,
    });

  if (!initialized) return <>Initializing Resource</>;

  return (
    <Column>
      <NewFormTitle classSubject={classSubject} />
      <SubjectField
        error={subjectErr}
        value={subjectValue}
        onChange={setSubjectValue}
      />
      {/* Key is required for re-rendering when subject changes */}
      <ResourceForm
        resource={resource}
        classSubject={classSubject}
        key={`${classSubject}+${subject}`}
      />
    </Column>
  );
};
