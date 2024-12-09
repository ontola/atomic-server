# Atomic Next.js Template

This repository is a [Next.js](https://nextjs.org/) 15 website starter template to be used with [AtomicServer](https://github.com/atomicdata-dev/atomic-server). For specific steps on how to deploy this template, see [DEPLOYING](./README/deploying.md).

## Getting started

This guide assumes you have AtomicServer running on your local machine. If you don't, you can follow the [AtomicServer installation guide](https://docs.atomicdata.dev/atomicserver/installation).

### 1. Create a new project

```bash
$ npm create @tomic/template my-project -- --template nextjs-site --server-url http://localhost:9883
$ pnpm create @tomic/template my-project --template nextjs-site --server-url http://localhost:9883
$ yarn create @tomic/template my-project --template nextjs-site --server-url http://localhost:9883
```

### 2. Generate ontologies

```bash
$ cd my-project
```

```bash
$ npx ad-generate ontologies
$ pnpm exec ad-generate ontologies
$ yarn ad-generate ontologies
```

After making changes to an ontology you need to re-generate them in your code.

### 3. Start the development server

```bash
$ npm run dev
$ pnpm dev
$ yarn dev
```

## Structure

Atomic Data resources are rendered by views.
These views are components that accept a resource as prop and render the data in a certain way.
For example the `BlogPostFullPage` view renders a `blog-post` resource as a full page.

Oftentimes these views also come with a kind of view selector component that determines what component to render based on the resources class.
An example of this would be `FullPageView`.

These selector components are great for when a resource can reference another resource without a classtype, meaning it can be any kind of resource.
For example, the `page` class has a `blocks` property that can reference any type of resource.
The FullPage view for the `page` class (`PageFullPage`) therefore renders a `BlockView` component that selects the appropriate component to render, i.e. a `TextBlock` or an `ImageGalleryBlock`.

## Deploying

### Deploying to Netlify

#### Prerequisites

- A [Netlify](https://www.netlify.com/) account
- A Git repository with your template project

#### UI

1. Click on the "Add new site" button and select "Import an existing project".
2. Choose your Git provider and select the repository where your project is located.
3. Add the environment variables required by your project

#### CLI

1. Install the Netlify CLI by running `npm install -g netlify-cli`.
2. Run `netlify login` and log in.
3. Run `netlify init` and select the repository you want to deploy.
4. Run `netlify deploy` to deploy the site.

### Deploying to Vercel

#### Prerequisites

- A [Vercel](https://vercel.com/) account
- A Git repository with your template project

#### UI

1. Click on the "Import Project" button and select the repository where your project is located.
2. Add the environment variables required by your project.

#### CLI

1. Install the Vercel CLI by running `npm install -g vercel`.
2. Run `vercel login` and log in.
3. Run `vercel` and select the repository you want to deploy.
4. Run `vercel --prod` to deploy the site to production.

## Resources

- [AtomicServer Docs](https://docs.atomicdata.dev/)
- [Next.js Docs](https://nextjs.org/docs)
- [Discord](https://discord.gg/a72Rv2P)
