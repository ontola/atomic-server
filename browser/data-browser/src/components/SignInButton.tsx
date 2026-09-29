import { paths } from '../routes/paths';
import { Button } from './Button';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

/**
 * Button that currently links to the Agent Settings page. Should probably open
 * in a Modal.
 */
export function SignInButton() {
  const navigate = useNavigateWithTransition();

  return (
    <Button
      type='button'
      onClick={() => navigate(paths.agentSettings)}
      title='Go to the User page'
    >
      Sign in
    </Button>
  );
}
