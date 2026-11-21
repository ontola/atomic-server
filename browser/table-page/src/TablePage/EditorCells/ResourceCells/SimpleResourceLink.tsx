import { Resource } from '@tomic/react';
import { useMemo, type JSX } from 'react';
import { useResourceNavigation } from '@tomic/resource-ui/ResourceUIHost';
import { useNavigateWithTransition } from '@tomic/resource-ui/ResourceUIHost';
import { styled } from 'styled-components';

export type SimpleResourceLinkProps = {
  resource: Resource;
} & Omit<React.HTMLAttributes<HTMLAnchorElement>, 'children' | 'resource'>;

export function SimpleResourceLink({
  resource,
  children,
  ...props
}: React.PropsWithChildren<SimpleResourceLinkProps>): JSX.Element {
  const { constructOpenURL } = useResourceNavigation();
  const navigate = useNavigateWithTransition();

  const url = useMemo(() => {
    try {
      return constructOpenURL(resource.subject);
    } catch (e) {
      return '#';
    }
  }, [resource, constructOpenURL]);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    navigate(url);
  };

  return (
    <StyledAnchor href={url} onClick={handleClick} {...props}>
      {children}
    </StyledAnchor>
  );
}

const StyledAnchor = styled.a`
  text-decoration: none;

  &:hover,
  &:focus-visible {
    text-decoration: underline;
  }
`;
