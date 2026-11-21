import { paths } from '../routes/paths';
import { Button } from '@tomic/ui/components/Button';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';

/** Button that opens the sign-in flow, and brings you to your account settings after. */
export function SignInButton() {
  const navigate = useNavigateWithTransition();

  return (
    <Button
      type='button'
      onClick={() => navigate(`${paths.welcome}?return_to=agent`)}
    >
      Sign in
    </Button>
  );
}
