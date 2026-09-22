# Creating a portfolio website using Astro and Atomic Server

Atomic Server is a great fit for a headless CMS because it works seamlessly on the server and client while providing a top-notch developer experience.
In this guide, we will build a portfolio site using [Astro](https://astro.build/) to serve and build our pages and use Atomic Data to hold our data.

Astro is a web framework for creating fast multi-page applications using web technology.
It plays very nicely with the `@tomic/lib` client library.

There are a few things that won't be covered in this guide like styling and CSS.
There will be very minimal use of CSS in this guide so we can focus on the technical parts of the website.
Feel free to spice it up and add some styling while following along though.

I will also not cover every little detail about Astro, only what is necessary to follow along with this guide.
If you're completely new to Astro consider skimming the [documentation](https://docs.astro.build/en/getting-started/) to see what it has to offer.

> [!NOTE]
> This guide uses AtomicServer as an HTTP data source: the site is built from data on a server you host, and the resources are addressed by that server's URLs. That is the right shape for a public website rendered at build time, and it still works as described.
> If you are building an app that people use on their own devices, start with the [local-first guide](../local-first-guide/1-index.md) instead, where a server is optional and added last.

With all that out of the way let's start by setting up your atomic data server. If you already have a server running skip to [Creating the frontend](3-frontend-setup.md)
