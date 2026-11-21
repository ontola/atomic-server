import {
  Spinner as ResourceSpinner,
  type SpinnerProps,
} from '@tomic/resource-ui/components/Spinner';
import { holdBootSplash } from '../helpers/bootSplash';
import { isEmbedded } from '../helpers/embedMode';

/** Early shell screens can load before the resource-UI host provider. */
const loadingPolicy = {
  hold: holdBootSplash,
  delay: (centered: boolean) => (centered && isEmbedded() ? 1000 : 0),
};

export function Spinner(props: SpinnerProps) {
  return <ResourceSpinner {...props} loadingPolicy={loadingPolicy} />;
}
