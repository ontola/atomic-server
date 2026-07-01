import * as React from 'react';
import { styled } from 'styled-components';
import { FaGithub, FaDiscord, FaBook } from 'react-icons/fa6';

import { createRoute } from '@tanstack/react-router';
import { ContainerNarrow } from '../components/Containers';
import { Main } from '../components/Main';
import { Logo } from '../components/Logo';
import { pathNames } from './paths';
import { appRoute } from './RootRoutes';

export const AboutRoute = createRoute({
  path: pathNames.about,
  component: () => <About />,
  getParentRoute: () => appRoute,
});

const features: [title: string, description: string][] = [
  [
    'Local-first & real-time',
    'Keep working offline — changes are stored on your device and sync instantly across tabs and devices over WebSockets, merged conflict-free with CRDTs.',
  ],
  [
    'Typed, linked data',
    'Every value has a datatype and every reference is a URL: the ease of JSON with the connectivity of linked data and the safety of types.',
  ],
  [
    'Documents, tables & chat',
    'Write rich documents, build spreadsheet-like tables and chat in real time — all stored as open, portable Atomic Data.',
  ],
  [
    'Versioned & signed history',
    'Every edit is a cryptographically signed commit, so you get a complete, tamper-evident history and time-travel for free.',
  ],
  [
    'Search & collections',
    'Full-text search and dynamic, filterable collections let you slice and navigate your whole graph.',
  ],
  [
    'Open & self-hostable',
    'An open protocol on an open-source stack. Own your data and run it anywhere.',
  ],
];

const links: {
  icon: React.ReactNode;
  label: string;
  description: string;
  href: string;
}[] = [
  {
    icon: <FaBook />,
    label: 'Documentation',
    description: 'Concepts, guides and the full API reference.',
    href: 'https://docs.atomicdata.dev',
  },
  {
    icon: <FaGithub />,
    label: 'GitHub',
    description: 'Source code, issues and releases.',
    href: 'https://github.com/atomicdata-dev/atomic-server',
  },
  {
    icon: <FaDiscord />,
    label: 'Discord',
    description: 'Ask questions and chat with the community.',
    href: 'https://discord.gg/a72Rv2P',
  },
];

const buildDate = (() => {
  try {
    return new Date(__BUILD_TIME__).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return __BUILD_TIME__;
  }
})();

export const About: React.FunctionComponent = () => {
  return (
    <Main>
      <ContainerNarrow>
        <Logo
          style={{ width: '22rem', maxWidth: '100%', marginBottom: '1.5rem' }}
        />
        <Tagline>
          The easiest way to create, share and model linked data.
        </Tagline>
        <Intro>
          Atomic Data combines the ease of use of JSON, the connectivity of
          linked data and the reliability of type-safety — one open protocol for
          knowledge graphs, collaborative apps and shareable datasets.
        </Intro>

        <h2>Features</h2>
        <FeatureList>
          {features.map(([title, description]) => (
            <Feature key={title}>
              <strong>{title}</strong>
              <span>{description}</span>
            </Feature>
          ))}
        </FeatureList>

        <h2>Learn more &amp; get involved</h2>
        <LinkGrid>
          {links.map(({ icon, label, description, href }) => (
            <LinkCard key={href} href={href} target='_blank' rel='noreferrer'>
              <LinkIcon>{icon}</LinkIcon>
              <LinkText>
                <LinkLabel>{label}</LinkLabel>
                <LinkDescription>{description}</LinkDescription>
              </LinkText>
            </LinkCard>
          ))}
        </LinkGrid>

        <BuildInfo>
          <span>Atomic&nbsp;Data&nbsp;Browser</span>
          <Mono title='Version'>v{__APP_VERSION__}</Mono>
          <Mono title='Build commit'>{__GIT_COMMIT__}</Mono>
          <span title={__BUILD_TIME__}>built {buildDate}</span>
        </BuildInfo>
      </ContainerNarrow>
    </Main>
  );
};

const Tagline = styled.p`
  font-size: 1.3rem;
  font-style: italic;
  color: ${p => p.theme.colors.textLight};
  margin-bottom: 0.5rem;
`;

const Intro = styled.p`
  font-size: 1.05rem;
  margin-bottom: 2rem;
`;

const FeatureList = styled.ul`
  list-style: none;
  padding: 0;
  margin: 0 0 2rem 0;
  display: grid;
  gap: 0.75rem;
`;

const Feature = styled.li`
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding-inline-start: 1rem;
  border-inline-start: 3px solid ${p => p.theme.colors.main};

  strong {
    color: ${p => p.theme.colors.text};
  }

  span {
    color: ${p => p.theme.colors.textLight};
  }
`;

const LinkGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1rem;
  margin-bottom: 3rem;
`;

const LinkCard = styled.a`
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 1rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
  background-color: ${p => p.theme.colors.bg};
  color: ${p => p.theme.colors.text};
  text-decoration: none;
  transition:
    border-color 0.1s ease,
    transform 0.1s ease;

  &:hover,
  &:focus-visible {
    border-color: ${p => p.theme.colors.main};
    transform: translateY(-2px);
  }
`;

const LinkIcon = styled.span`
  font-size: 1.6rem;
  color: ${p => p.theme.colors.main};
  display: flex;
`;

const LinkText = styled.div`
  display: flex;
  flex-direction: column;
`;

const LinkLabel = styled.span`
  font-weight: bold;
`;

const LinkDescription = styled.span`
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
`;

const BuildInfo = styled.footer`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding-top: 1.5rem;
  border-top: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  font-size: 0.85rem;
`;

const Mono = styled.code`
  background-color: ${p => p.theme.colors.bg1};
  border-radius: ${p => p.theme.radius};
  padding: 0.1rem 0.4rem;
`;
