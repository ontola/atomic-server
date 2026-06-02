import { useValue, type Datatype, type Resource } from '@tomic/react';
import { ValueForm } from './ValueForm';
import { useState } from 'react';
import { SkeletonButton } from '@components/SkeletonButton';
import { FaPlus } from 'react-icons/fa6';
import { styled } from 'styled-components';

interface ValueFormAddButtonProps {
  resource: Resource;
  propertyURL: string;
  datatype: Datatype;
  buttonLabel: string;
}

export const ValueFormAddButton: React.FC<
  React.PropsWithChildren<ValueFormAddButtonProps>
> = ({ resource, propertyURL, datatype, buttonLabel, children }) => {
  const [value] = useValue(resource, propertyURL);
  const [showForm, setShowForm] = useState(false);
  const hasValue = value !== undefined && value !== '';

  if (showForm || hasValue) {
    return (
      <>
        {children}
        <ValueForm
          resource={resource}
          propertyURL={propertyURL}
          datatype={datatype}
          defaultEditState={showForm}
          onStateChange={setShowForm}
        />
      </>
    );
  }

  return (
    <StyledSkeletonButton onClick={() => setShowForm(true)}>
      <FaPlus />
      {buttonLabel}
    </StyledSkeletonButton>
  );
};

const StyledSkeletonButton = styled(SkeletonButton)`
  height: 5rem;
  width: 100%;
`;
