export type TemplateKey = keyof typeof templates;

export type ExecutionContext = {
  serverUrl: string;
  drive: string;
  websiteSubject: string;
};

export type BaseTemplate = {
  name: string;
  ontologyLocalId: string;
  websiteLocalId: string;
  generateEnv: (context: ExecutionContext) => string;
};

const baseTemplates = {
  website: {
    name: 'website',
    ontologyLocalId: 'website',
    websiteLocalId: '01j5zrevq917dp0wm4p2vnd7nr',
    generateEnv: ({ serverUrl, drive, websiteSubject }) =>
      `PUBLIC_ATOMIC_SERVER_URL=${serverUrl}\nPUBLIC_ATOMIC_DRIVE=${drive}\nPUBLIC_WEBSITE_RESOURCE=${websiteSubject}`,
  },
} satisfies Record<string, BaseTemplate>;

export const templates = {
  'sveltekit-site': baseTemplates.website,
  'nextjs-site': {
    ...baseTemplates.website,
    generateEnv: ({ serverUrl, drive, websiteSubject }) =>
      `NEXT_PUBLIC_ATOMIC_SERVER_URL=${serverUrl}\nNEXT_PUBLIC_ATOMIC_DRIVE=${drive}\nNEXT_PUBLIC_WEBSITE_RESOURCE=${websiteSubject}`,
  },
} satisfies Record<string, BaseTemplate>;

export const isTemplate = (value: string): value is TemplateKey =>
  value in templates;
