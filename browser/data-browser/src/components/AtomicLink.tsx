import { ReactNode, useCallback, useEffect, useRef } from 'react';
import { styled } from 'styled-components';
import { constructOpenURL, pathToURL } from '../helpers/navigation';
import { FaExternalLinkAlt } from 'react-icons/fa';
import { ErrorLook } from '../components/ErrorLook';
import { isRunningInTauri } from '../helpers/tauri';
import { useNavigateWithTransition } from '../hooks/useNavigateWithTransition';
import clsx from 'clsx';
import { useIsInRTE } from '@hooks/useIsInRTE';
import { useCombineRefs } from '@hooks/useCombineRefs';

export interface AtomicLinkProps
  extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  children?: ReactNode;
  /** An http URL to an Atomic Data resource, opened in this app and fetched as JSON-AD */
  subject?: string;
  /** An http URL to some (external) resource, opened in a new tab and fetched as HTML */
  href?: string;
  /** A path string, e.g. /new, opened using the internal router */
  path?: string;
  untabbable?: boolean;
  /** Minimal styling applied */
  clean?: boolean;
  /** Used to extend with styled */
  className?: string;
  ref?: React.Ref<HTMLAnchorElement>;
}

/**
 * Renders a link. Either a subject or a href is required. You can wrap this
 * around other components and pass the `clean` prop to skip styling.
 */
export const AtomicLink: React.FC<React.PropsWithChildren<AtomicLinkProps>> = ({
  children,
  clean,
  subject,
  path,
  href,
  untabbable,
  className,
  ref,
  ...props
}) => {
  const innerRef = useRef<HTMLAnchorElement>(null);
  const combinedRef = useCombineRefs([ref, innerRef]);
  const navigate = useNavigateWithTransition();
  const isInRTE = useIsInRTE();

  let isOnCurrentPage: boolean;

  const handleClick = (e: React.MouseEvent<HTMLElement>) => {
    if (href) {
      // When there is a regular URL, let the browser handle it
      return;
    }

    e.preventDefault();

    if (path) {
      navigate(path);

      return;
    }

    if (subject) {
      if (isOnCurrentPage) {
        return;
      }

      navigate(constructOpenURL(subject));
    }
  };

  const constructHref = useCallback(
    () => href || subject || pathToURL(path!),
    [href, subject, path],
  );

  let hrefConstructed: string | undefined = constructHref();

  if (isInRTE) {
    // HACK: The Tiptap editor has an event handler that always opens links in new tabs. We can't disable it so we have to remove the href from links when inside the editor.
    hrefConstructed = undefined;
  }

  useEffect(() => {
    if (!innerRef.current) return;

    if (!isInRTE) return;

    // HACK: Because we remove the href from the links in the RTE we need to restore them when printing.
    const handleBeforePrint = () => {
      innerRef.current?.setAttribute('href', constructHref());
    };

    const handleAfterPrint = () => {
      innerRef.current?.removeAttribute('href');
    };

    window.addEventListener('beforeprint', handleBeforePrint);
    window.addEventListener('afterprint', handleAfterPrint);

    return () => {
      window.removeEventListener('beforeprint', handleBeforePrint);
      window.removeEventListener('afterprint', handleAfterPrint);
    };
  }, [constructHref, isInRTE]);

  if (subject === undefined && href === undefined && path === undefined) {
    return (
      <ErrorLook>
        No `subject`, `path` or `href` passed to this AtomicLink.
      </ErrorLook>
    );
  }

  try {
    isOnCurrentPage = subject
      ? window.location.toString() === constructOpenURL(subject)
      : false;
  } catch (e) {
    return <span>{subject}</span>;
  }

  return (
    <LinkView
      clean={clean}
      className={clsx(className, { 'atomic-link_external': href && !clean })}
      about={subject}
      onClick={handleClick}
      href={hrefConstructed}
      disabled={isOnCurrentPage}
      tabIndex={isOnCurrentPage || untabbable ? -1 : 0}
      // Tauri always opens `_blank` in new tab, and ignores preventDefault() for some reason.
      // https://github.com/tauri-apps/tauri/issues/1657
      target={isRunningInTauri() && !href ? '' : '_blank'}
      {...props}
      ref={combinedRef}
    >
      {children}
      {href && !clean && (
        <>
          {' '}
          <FaExternalLinkAlt size='0.8em' />
        </>
      )}
    </LinkView>
  );
};

AtomicLink.displayName = 'AtomicLink';

type LinkViewProps = {
  disabled?: boolean;
  /** Minimal styling applied */
  clean?: boolean;
};

/** Look clickable, should be used for opening things only - not interactions. */
export const LinkView = styled.a<LinkViewProps>`
  color: ${props =>
    props.disabled ? props.theme.colors.text : props.theme.colors.main};
  text-decoration: none;
  cursor: pointer;
  pointer-events: ${props => (props.disabled ? 'none' : 'inherit')};

  &:hover {
    color: ${props => props.theme.colors.mainLight};
    text-decoration: ${p => (p.clean ? 'none' : 'underline')};
  }
  &:active {
    color: ${props => props.theme.colors.mainDark};
  }

  &.atomic-link_external {
    align-items: center;
    gap: 0.6ch;
  }
`;
