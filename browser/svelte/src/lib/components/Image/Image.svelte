<script lang="ts">
  import { getResource } from '$lib/stores/getResource.svelte.js';
  import { type Server } from '@tomic/lib';
  import type { HTMLImgAttributes } from 'svelte/elements';
  import {
    buildSrcSet,
    DEFAULT_SIZES,
    imageFormatsWithBasicSupport,
    imageFormatsWithFullSupport,
    indicationToSizes,
    type SizeIndication,
  } from './imageHelpers.js';

  enum Support {
    Full,
    Basic,
    None,
  }

  interface Props extends HTMLImgAttributes {
    subject: string;
    alt: string;
    noBaseStyles?: boolean;
    quality?: number;
    sizeIndication?: SizeIndication;
  }

  const {
    subject,
    alt,
    noBaseStyles,
    quality = 60,
    sizeIndication,
    ...restProps
  }: Props = $props();

  let resource = getResource<Server.File>(() => subject);

  let support = $derived.by(() => {
    if (imageFormatsWithFullSupport.has(resource.props.mimetype ?? '')) {
      return Support.Full;
    } else if (
      imageFormatsWithBasicSupport.has(resource.props.mimetype ?? '')
    ) {
      return Support.Basic;
    } else {
      return Support.None;
    }
  });

  let toSrcSet = $derived(buildSrcSet(resource.props.downloadUrl));
</script>

{#if resource.error}
  <p>{resource.error.message}</p>
{:else if resource.loading}
  <p>Loading...</p>
{:else if support === Support.None}
  <p>Image format not supported</p>
{:else if support === Support.Basic}
  <img
    src={resource.props.downloadUrl}
    class:base-styles={!noBaseStyles}
    {alt}
    height={resource.props.imageHeight}
    width={resource.props.imageWidth}
    {...restProps}
  />
{:else if support === Support.Full}
  <picture>
    <source
      srcSet={toSrcSet('avif', quality, DEFAULT_SIZES)}
      type="image/avif"
      sizes={indicationToSizes(sizeIndication)}
      height={resource.props.imageHeight}
      width={resource.props.imageWidth}
    />
    <source
      srcSet={toSrcSet('webp', quality, DEFAULT_SIZES)}
      type="image/webp"
      sizes={indicationToSizes(sizeIndication)}
      height={resource.props.imageHeight}
      width={resource.props.imageWidth}
    />
    <img
      src={resource.props.downloadUrl}
      class:base-styles={!noBaseStyles}
      {alt}
      height={resource.props.imageHeight}
      width={resource.props.imageWidth}
      {...restProps}
    />
  </picture>
{/if}

<style>
  .base-styles {
    max-width: 100%;
    height: auto;
  }
</style>
