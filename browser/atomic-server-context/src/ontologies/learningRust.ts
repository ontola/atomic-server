
/* -----------------------------------
* GENERATED WITH @tomic/cli
* For more info on how to use ontologies: https://github.com/atomicdata-dev/atomic-server/blob/develop/browser/cli/readme.md
* -------------------------------- */

import type { BaseProps } from '@tomic/lib';

export const learningRust = {
    classes: {
	homepage: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/class/homepage',
	project: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/class/project',
	blogPost: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/class/blog-post',
   },
    properties: {
	heading: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/heading',
	subHeading: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/sub-heading',
	bodyText: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/body-text',
	headerImage: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/header-image',
	projects: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/projects',
	image: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/image',
	demoUrl: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/demo-url',
	repoUrl: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/repo-url',
	titleSlug: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/url-slug',
	publishedAt: 'https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/property/published-at',
   },
  } as const;

export type Homepage = typeof learningRust.classes.homepage;
export type Project = typeof learningRust.classes.project;
export type BlogPost = typeof learningRust.classes.blogPost;

declare module '@tomic/lib' {
  interface Classes {
    [learningRust.classes.homepage]: {
    requires: BaseProps | 'https://atomicdata.dev/properties/name' | typeof learningRust.properties.heading | typeof learningRust.properties.subHeading | typeof learningRust.properties.bodyText | typeof learningRust.properties.headerImage;
    recommends: typeof learningRust.properties.projects;
  };
[learningRust.classes.project]: {
    requires: BaseProps | 'https://atomicdata.dev/properties/name' | 'https://atomicdata.dev/properties/description' | typeof learningRust.properties.image;
    recommends: typeof learningRust.properties.demoUrl | typeof learningRust.properties.repoUrl;
  };
[learningRust.classes.blogPost]: {
    requires: BaseProps | 'https://atomicdata.dev/properties/name' | 'https://atomicdata.dev/properties/description' | typeof learningRust.properties.image | typeof learningRust.properties.titleSlug | typeof learningRust.properties.publishedAt;
    recommends: never;
  };
  }

  interface PropTypeMapping {
    [learningRust.properties.heading]: string
[learningRust.properties.subHeading]: string
[learningRust.properties.bodyText]: string
[learningRust.properties.headerImage]: string
[learningRust.properties.projects]: string[]
[learningRust.properties.image]: string
[learningRust.properties.demoUrl]: string
[learningRust.properties.repoUrl]: string
[learningRust.properties.titleSlug]: string
[learningRust.properties.publishedAt]: number
  }

  interface PropSubjectToNameMapping {
    [learningRust.properties.heading]: 'heading',
[learningRust.properties.subHeading]: 'subHeading',
[learningRust.properties.bodyText]: 'bodyText',
[learningRust.properties.headerImage]: 'headerImage',
[learningRust.properties.projects]: 'projects',
[learningRust.properties.image]: 'image',
[learningRust.properties.demoUrl]: 'demoUrl',
[learningRust.properties.repoUrl]: 'repoUrl',
[learningRust.properties.titleSlug]: 'titleSlug',
[learningRust.properties.publishedAt]: 'publishedAt',
  }
}
