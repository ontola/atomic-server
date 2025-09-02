/* -----------------------------------
 * GENERATED WITH @tomic/cli
 * For more info on how to use ontologies: https://github.com/atomicdata-dev/atomic-server/blob/develop/browser/cli/readme.md
 * -------------------------------- */

import type { OntologyBaseObject, BaseProps } from '@tomic/lib';

export const dataBrowser = {
  classes: {
    article: 'https://atomicdata.dev/classes/Article',
    bookmark: 'https://atomicdata.dev/class/Bookmark',
    chatroom: 'https://atomicdata.dev/classes/ChatRoom',
    currencyProperty:
      'https://atomicdata.dev/ontology/data-browser/class/currency-property',
    dateFormat: 'https://atomicdata.dev/classes/DateFormat',
    displayStyle: 'https://atomicdata.dev/class/DisplayStyle',
    document: 'https://atomicdata.dev/classes/Document',
    floatRangeProperty: 'https://atomicdata.dev/classes/FloatRangeProperty',
    folder: 'https://atomicdata.dev/classes/Folder',
    formattedDate: 'https://atomicdata.dev/classes/FormattedDate',
    formattedNumber: 'https://atomicdata.dev/classes/FormattedNumber',
    importer: 'https://atomicdata.dev/classes/Importer',
    message: 'https://atomicdata.dev/classes/Message',
    numberFormat: 'https://atomicdata.dev/classes/NumberFormat',
    paragraph: 'https://atomicdata.dev/classes/elements/Paragraph',
    rangeProperty: 'https://atomicdata.dev/classes/RangeProperty',
    selectProperty: 'https://atomicdata.dev/classes/SelectProperty',
    table: 'https://atomicdata.dev/classes/Table',
    tag: 'https://atomicdata.dev/classes/Tag',
    template: 'https://atomicdata.dev/ontology/data-browser/class/template',
  },
  properties: {
    color: 'https://atomicdata.dev/properties/color',
    currency: 'https://atomicdata.dev/ontology/data-browser/property/currency',
    customNodePositioning:
      'https://atomicdata.dev/properties/custom-node-positioning',
    dateFormat: 'https://atomicdata.dev/properties/dateFormat',
    decimalPlaces: 'https://atomicdata.dev/properties/decimalPlaces',
    displayStyle: 'https://atomicdata.dev/property/display-style',
    elements: 'https://atomicdata.dev/properties/documents/elements',
    emoji: 'https://atomicdata.dev/properties/emoji',
    image: 'https://atomicdata.dev/ontology/data-browser/property/image',
    imageUrl: 'https://atomicdata.dev/properties/imageUrl',
    max: 'https://atomicdata.dev/properties/max',
    maxFloat: 'https://atomicdata.dev/properties/maxFloat',
    messages: 'https://atomicdata.dev/properties/messages',
    min: 'https://atomicdata.dev/properties/min',
    minFloat: 'https://atomicdata.dev/properties/minFloat',
    nextPage: 'https://atomicdata.dev/properties/nextPage',
    numberFormatting: 'https://atomicdata.dev/properties/numberFormatting',
    preview: 'https://atomicdata.dev/property/preview',
    publishedAt: 'https://atomicdata.dev/properties/published-at',
    replyTo: 'https://atomicdata.dev/properties/replyTo',
    resources:
      'https://atomicdata.dev/ontology/data-browser/property/resources',
    subResources: 'https://atomicdata.dev/properties/subresources',
    tableColumnWidths: 'https://atomicdata.dev/properties/tableColumnWidths',
    tags: 'https://atomicdata.dev/properties/tags',
    url: 'https://atomicdata.dev/property/url',
  },
  __classDefs: {
    ['https://atomicdata.dev/classes/Article']: [
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/tags',
      'https://atomicdata.dev/properties/published-at',
    ],
    ['https://atomicdata.dev/class/Bookmark']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/property/url',
      'https://atomicdata.dev/property/preview',
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/imageUrl',
    ],
    ['https://atomicdata.dev/classes/ChatRoom']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/messages',
    ],
    ['https://atomicdata.dev/ontology/data-browser/class/currency-property']: [
      'https://atomicdata.dev/ontology/data-browser/property/currency',
    ],
    ['https://atomicdata.dev/classes/DateFormat']: [
      'https://atomicdata.dev/properties/shortname',
    ],
    ['https://atomicdata.dev/class/DisplayStyle']: [
      'https://atomicdata.dev/properties/name',
    ],
    ['https://atomicdata.dev/classes/Document']: [
      'https://atomicdata.dev/properties/documents/elements',
      'https://atomicdata.dev/properties/name',
    ],
    ['https://atomicdata.dev/classes/FloatRangeProperty']: [
      'https://atomicdata.dev/properties/minFloat',
      'https://atomicdata.dev/properties/maxFloat',
    ],
    ['https://atomicdata.dev/classes/Folder']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/property/display-style',
      'https://atomicdata.dev/properties/subresources',
    ],
    ['https://atomicdata.dev/classes/FormattedDate']: [
      'https://atomicdata.dev/properties/dateFormat',
    ],
    ['https://atomicdata.dev/classes/FormattedNumber']: [
      'https://atomicdata.dev/properties/numberFormatting',
      'https://atomicdata.dev/properties/decimalPlaces',
    ],
    ['https://atomicdata.dev/classes/Importer']: [],
    ['https://atomicdata.dev/classes/Message']: [
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/parent',
    ],
    ['https://atomicdata.dev/classes/NumberFormat']: [
      'https://atomicdata.dev/properties/shortname',
    ],
    ['https://atomicdata.dev/classes/elements/Paragraph']: [
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/properties/parent',
    ],
    ['https://atomicdata.dev/classes/RangeProperty']: [
      'https://atomicdata.dev/properties/min',
      'https://atomicdata.dev/properties/max',
    ],
    ['https://atomicdata.dev/classes/SelectProperty']: [
      'https://atomicdata.dev/properties/allowsOnly',
      'https://atomicdata.dev/properties/max',
    ],
    ['https://atomicdata.dev/classes/Table']: [
      'https://atomicdata.dev/properties/classtype',
      'https://atomicdata.dev/properties/name',
    ],
    ['https://atomicdata.dev/classes/Tag']: [
      'https://atomicdata.dev/properties/shortname',
      'https://atomicdata.dev/properties/color',
      'https://atomicdata.dev/properties/emoji',
    ],
    ['https://atomicdata.dev/ontology/data-browser/class/template']: [
      'https://atomicdata.dev/properties/name',
      'https://atomicdata.dev/properties/description',
      'https://atomicdata.dev/ontology/data-browser/property/image',
      'https://atomicdata.dev/ontology/data-browser/property/resources',
    ],
  },
} as const satisfies OntologyBaseObject;

export type Article = typeof dataBrowser.classes.article;
export type Bookmark = typeof dataBrowser.classes.bookmark;
export type Chatroom = typeof dataBrowser.classes.chatroom;
export type CurrencyProperty = typeof dataBrowser.classes.currencyProperty;
export type DateFormat = typeof dataBrowser.classes.dateFormat;
export type DisplayStyle = typeof dataBrowser.classes.displayStyle;
export type Document = typeof dataBrowser.classes.document;
export type FloatRangeProperty = typeof dataBrowser.classes.floatRangeProperty;
export type Folder = typeof dataBrowser.classes.folder;
export type FormattedDate = typeof dataBrowser.classes.formattedDate;
export type FormattedNumber = typeof dataBrowser.classes.formattedNumber;
export type Importer = typeof dataBrowser.classes.importer;
export type Message = typeof dataBrowser.classes.message;
export type NumberFormat = typeof dataBrowser.classes.numberFormat;
export type Paragraph = typeof dataBrowser.classes.paragraph;
export type RangeProperty = typeof dataBrowser.classes.rangeProperty;
export type SelectProperty = typeof dataBrowser.classes.selectProperty;
export type Table = typeof dataBrowser.classes.table;
export type Tag = typeof dataBrowser.classes.tag;
export type Template = typeof dataBrowser.classes.template;

class articleElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'undefined', 'tags', 'publishedAt'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/description',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const tags = this._resource.get('https://atomicdata.dev/properties/tags');
      if (tags) {
        this.setAttribute('tags', tags);
      }

      const publishedAt = this._resource.get(
        'https://atomicdata.dev/properties/published-at',
      );
      if (publishedAt) {
        this.setAttribute('publishedAt', publishedAt);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">tags:</span>
          <span class="property-value">${this.getAttribute('tags') || ''}</span>
        </div>

        <div class="property">
          <span class="property-label">publishedAt:</span>
          <span class="property-value">${
            this.getAttribute('publishedAt') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-article', articleElement);

class bookmarkElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'url', 'preview', 'undefined', 'imageUrl'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const url = this._resource.get('https://atomicdata.dev/property/url');
      if (url) {
        this.setAttribute('url', url);
      }

      const preview = this._resource.get(
        'https://atomicdata.dev/property/preview',
      );
      if (preview) {
        this.setAttribute('preview', preview);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/description',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const imageUrl = this._resource.get(
        'https://atomicdata.dev/properties/imageUrl',
      );
      if (imageUrl) {
        this.setAttribute('imageUrl', imageUrl);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">url:</span>
          <span class="property-value">${this.getAttribute('url') || ''}</span>
        </div>

        <div class="property">
          <span class="property-label">preview:</span>
          <span class="property-value">${
            this.getAttribute('preview') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">imageUrl:</span>
          <span class="property-value">${
            this.getAttribute('imageUrl') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('url') ? 'block' : 'none'
        }">
          Required: url
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-bookmark', bookmarkElement);

class chatroomElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'messages'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const messages = this._resource.get(
        'https://atomicdata.dev/properties/messages',
      );
      if (messages) {
        this.setAttribute('messages', messages);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">messages:</span>
          <span class="property-value">${
            this.getAttribute('messages') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-chatroom', chatroomElement);

class currencyPropertyElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'currency'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const currency = this._resource.get(
        'https://atomicdata.dev/ontology/data-browser/property/currency',
      );
      if (currency) {
        this.setAttribute('currency', currency);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">currency:</span>
          <span class="property-value">${
            this.getAttribute('currency') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('currency') ? 'block' : 'none'
        }">
          Required: currency
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-currency-property', currencyPropertyElement);

class dateFormatElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/shortname',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-date-format', dateFormatElement);

class displayStyleElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-display-style', displayStyleElement);

class documentElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'elements', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const elements = this._resource.get(
        'https://atomicdata.dev/properties/documents/elements',
      );
      if (elements) {
        this.setAttribute('elements', elements);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">elements:</span>
          <span class="property-value">${
            this.getAttribute('elements') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
      </div>
    `;
  }
}

customElements.define('atomic-document', documentElement);

class floatRangePropertyElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'minFloat', 'maxFloat'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const minFloat = this._resource.get(
        'https://atomicdata.dev/properties/minFloat',
      );
      if (minFloat) {
        this.setAttribute('minFloat', minFloat);
      }

      const maxFloat = this._resource.get(
        'https://atomicdata.dev/properties/maxFloat',
      );
      if (maxFloat) {
        this.setAttribute('maxFloat', maxFloat);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">minFloat:</span>
          <span class="property-value">${
            this.getAttribute('minFloat') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">maxFloat:</span>
          <span class="property-value">${
            this.getAttribute('maxFloat') || ''
          }</span>
        </div>
        
      </div>
    `;
  }
}

customElements.define('atomic-float-range-property', floatRangePropertyElement);

class folderElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'displayStyle', 'subResources'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const displayStyle = this._resource.get(
        'https://atomicdata.dev/property/display-style',
      );
      if (displayStyle) {
        this.setAttribute('displayStyle', displayStyle);
      }

      const subResources = this._resource.get(
        'https://atomicdata.dev/properties/subresources',
      );
      if (subResources) {
        this.setAttribute('subResources', subResources);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">displayStyle:</span>
          <span class="property-value">${
            this.getAttribute('displayStyle') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">subResources:</span>
          <span class="property-value">${
            this.getAttribute('subResources') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('displayStyle') ? 'block' : 'none'
        }">
          Required: displayStyle
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-folder', folderElement);

class formattedDateElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'dateFormat'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const dateFormat = this._resource.get(
        'https://atomicdata.dev/properties/dateFormat',
      );
      if (dateFormat) {
        this.setAttribute('dateFormat', dateFormat);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">dateFormat:</span>
          <span class="property-value">${
            this.getAttribute('dateFormat') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('dateFormat') ? 'block' : 'none'
        }">
          Required: dateFormat
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-formatted-date', formattedDateElement);

class formattedNumberElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'numberFormatting', 'decimalPlaces'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const numberFormatting = this._resource.get(
        'https://atomicdata.dev/properties/numberFormatting',
      );
      if (numberFormatting) {
        this.setAttribute('numberFormatting', numberFormatting);
      }

      const decimalPlaces = this._resource.get(
        'https://atomicdata.dev/properties/decimalPlaces',
      );
      if (decimalPlaces) {
        this.setAttribute('decimalPlaces', decimalPlaces);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">numberFormatting:</span>
          <span class="property-value">${
            this.getAttribute('numberFormatting') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">decimalPlaces:</span>
          <span class="property-value">${
            this.getAttribute('decimalPlaces') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('numberFormatting') ? 'block' : 'none'
        }">
          Required: numberFormatting
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-formatted-number', formattedNumberElement);

class importerElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        
      </div>
    `;
  }
}

customElements.define('atomic-importer', importerElement);

class messageElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/description',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/parent',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-message', messageElement);

class numberFormatElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/shortname',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-number-format', numberFormatElement);

class paragraphElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/description',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/parent',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-paragraph', paragraphElement);

class rangePropertyElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'min', 'max'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const min = this._resource.get('https://atomicdata.dev/properties/min');
      if (min) {
        this.setAttribute('min', min);
      }

      const max = this._resource.get('https://atomicdata.dev/properties/max');
      if (max) {
        this.setAttribute('max', max);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">min:</span>
          <span class="property-value">${this.getAttribute('min') || ''}</span>
        </div>

        <div class="property">
          <span class="property-label">max:</span>
          <span class="property-value">${this.getAttribute('max') || ''}</span>
        </div>
        
      </div>
    `;
  }
}

customElements.define('atomic-range-property', rangePropertyElement);

class selectPropertyElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'max'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/allowsOnly',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const max = this._resource.get('https://atomicdata.dev/properties/max');
      if (max) {
        this.setAttribute('max', max);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">max:</span>
          <span class="property-value">${this.getAttribute('max') || ''}</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-select-property', selectPropertyElement);

class tableElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'undefined'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/classtype',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-table', tableElement);

class tagElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'color', 'emoji'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/shortname',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const color = this._resource.get(
        'https://atomicdata.dev/properties/color',
      );
      if (color) {
        this.setAttribute('color', color);
      }

      const emoji = this._resource.get(
        'https://atomicdata.dev/properties/emoji',
      );
      if (emoji) {
        this.setAttribute('emoji', emoji);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">color:</span>
          <span class="property-value">${
            this.getAttribute('color') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">emoji:</span>
          <span class="property-value">${
            this.getAttribute('emoji') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-tag', tagElement);

class templateElement extends HTMLElement {
  static get observedAttributes() {
    return ['subject', 'undefined', 'undefined', 'image', 'resources'];
  }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._resource = null;
    this._loading = false;
  }

  async connectedCallback() {
    this.render();
    await this.loadResource();
  }

  async attributeChangedCallback(name, oldValue, newValue) {
    if (name === 'subject' && oldValue !== newValue) {
      await this.loadResource();
    }
    this.render();
  }

  async loadResource() {
    const subject = this.getAttribute('subject');
    if (!subject || this._loading) {
      return;
    }

    try {
      this._loading = true;
      this._resource = await store.getResource(subject);

      // Set attributes based on resource properties

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/name',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const undefined = this._resource.get(
        'https://atomicdata.dev/properties/description',
      );
      if (undefined) {
        this.setAttribute('undefined', undefined);
      }

      const image = this._resource.get(
        'https://atomicdata.dev/ontology/data-browser/property/image',
      );
      if (image) {
        this.setAttribute('image', image);
      }

      const resources = this._resource.get(
        'https://atomicdata.dev/ontology/data-browser/property/resources',
      );
      if (resources) {
        this.setAttribute('resources', resources);
      }
    } catch (e) {
      console.error('Error loading resource:', e);
    } finally {
      this._loading = false;
      this.render();
    }
  }

  render() {
    if (!this.shadowRoot) return;

    const loading = this._loading;
    const subject = this.getAttribute('subject');

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          font-family: system-ui, sans-serif;
          padding: 1rem;
          border: 1px solid #eee;
          border-radius: 0.5rem;
        }
        .loading {
          opacity: 0.5;
        }
        .property {
          margin: 0.5rem 0;
        }
        .property-label {
          font-weight: 500;
          color: #666;
          margin-right: 0.5rem;
        }
        .property-value {
          color: #333;
        }
        .error {
          color: #e11;
        }
      </style>
      <div class="atomic-resource ${loading ? 'loading' : ''}">
        
        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">undefined:</span>
          <span class="property-value">${
            this.getAttribute('undefined') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">image:</span>
          <span class="property-value">${
            this.getAttribute('image') || ''
          }</span>
        </div>

        <div class="property">
          <span class="property-label">resources:</span>
          <span class="property-value">${
            this.getAttribute('resources') || ''
          }</span>
        </div>
        
        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('undefined') ? 'block' : 'none'
        }">
          Required: undefined
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('image') ? 'block' : 'none'
        }">
          Required: image
        </div>

        <div class="property error" style="display: ${
          !this.getAttribute('resources') ? 'block' : 'none'
        }">
          Required: resources
        </div>
      </div>
    `;
  }
}

customElements.define('atomic-template', templateElement);

declare module '@tomic/lib' {
  interface Classes {
    [dataBrowser.classes.article]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/description'
        | 'https://atomicdata.dev/properties/name';
      recommends:
        | typeof dataBrowser.properties.tags
        | typeof dataBrowser.properties.publishedAt;
    };
    [dataBrowser.classes.bookmark]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | typeof dataBrowser.properties.url;
      recommends:
        | typeof dataBrowser.properties.preview
        | 'https://atomicdata.dev/properties/description'
        | typeof dataBrowser.properties.imageUrl;
    };
    [dataBrowser.classes.chatroom]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/name';
      recommends: typeof dataBrowser.properties.messages;
    };
    [dataBrowser.classes.currencyProperty]: {
      requires: BaseProps | typeof dataBrowser.properties.currency;
      recommends: never;
    };
    [dataBrowser.classes.dateFormat]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/shortname';
      recommends: never;
    };
    [dataBrowser.classes.displayStyle]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/name';
      recommends: never;
    };
    [dataBrowser.classes.document]: {
      requires: BaseProps;
      recommends:
        | typeof dataBrowser.properties.elements
        | 'https://atomicdata.dev/properties/name';
    };
    [dataBrowser.classes.floatRangeProperty]: {
      requires: BaseProps;
      recommends:
        | typeof dataBrowser.properties.minFloat
        | typeof dataBrowser.properties.maxFloat;
    };
    [dataBrowser.classes.folder]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | typeof dataBrowser.properties.displayStyle;
      recommends: typeof dataBrowser.properties.subResources;
    };
    [dataBrowser.classes.formattedDate]: {
      requires: BaseProps | typeof dataBrowser.properties.dateFormat;
      recommends: never;
    };
    [dataBrowser.classes.formattedNumber]: {
      requires: BaseProps | typeof dataBrowser.properties.numberFormatting;
      recommends: typeof dataBrowser.properties.decimalPlaces;
    };
    [dataBrowser.classes.importer]: {
      requires: BaseProps;
      recommends: never;
    };
    [dataBrowser.classes.message]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/description'
        | 'https://atomicdata.dev/properties/parent';
      recommends: never;
    };
    [dataBrowser.classes.numberFormat]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/shortname';
      recommends: never;
    };
    [dataBrowser.classes.paragraph]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/description'
        | 'https://atomicdata.dev/properties/parent';
      recommends: never;
    };
    [dataBrowser.classes.rangeProperty]: {
      requires: BaseProps;
      recommends:
        | typeof dataBrowser.properties.min
        | typeof dataBrowser.properties.max;
    };
    [dataBrowser.classes.selectProperty]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/allowsOnly';
      recommends: typeof dataBrowser.properties.max;
    };
    [dataBrowser.classes.table]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/classtype'
        | 'https://atomicdata.dev/properties/name';
      recommends: never;
    };
    [dataBrowser.classes.tag]: {
      requires: BaseProps | 'https://atomicdata.dev/properties/shortname';
      recommends:
        | typeof dataBrowser.properties.color
        | typeof dataBrowser.properties.emoji;
    };
    [dataBrowser.classes.template]: {
      requires:
        | BaseProps
        | 'https://atomicdata.dev/properties/name'
        | 'https://atomicdata.dev/properties/description'
        | typeof dataBrowser.properties.image
        | typeof dataBrowser.properties.resources;
      recommends: never;
    };
  }

  interface PropTypeMapping {
    [dataBrowser.properties.color]: string;
    [dataBrowser.properties.currency]: string;
    [dataBrowser.properties.customNodePositioning]: string;
    [dataBrowser.properties.dateFormat]: string;
    [dataBrowser.properties.decimalPlaces]: number;
    [dataBrowser.properties.displayStyle]: string;
    [dataBrowser.properties.elements]: string[];
    [dataBrowser.properties.emoji]: string;
    [dataBrowser.properties.image]: string;
    [dataBrowser.properties.imageUrl]: string;
    [dataBrowser.properties.max]: number;
    [dataBrowser.properties.maxFloat]: number;
    [dataBrowser.properties.messages]: string[];
    [dataBrowser.properties.min]: number;
    [dataBrowser.properties.minFloat]: number;
    [dataBrowser.properties.nextPage]: string;
    [dataBrowser.properties.numberFormatting]: string;
    [dataBrowser.properties.preview]: string;
    [dataBrowser.properties.publishedAt]: number;
    [dataBrowser.properties.replyTo]: string;
    [dataBrowser.properties.resources]: string[];
    [dataBrowser.properties.subResources]: string[];
    [dataBrowser.properties.tableColumnWidths]: string;
    [dataBrowser.properties.tags]: string[];
    [dataBrowser.properties.url]: string;
  }

  interface PropSubjectToNameMapping {
    [dataBrowser.properties.color]: 'color';
    [dataBrowser.properties.currency]: 'currency';
    [dataBrowser.properties.customNodePositioning]: 'customNodePositioning';
    [dataBrowser.properties.dateFormat]: 'dateFormat';
    [dataBrowser.properties.decimalPlaces]: 'decimalPlaces';
    [dataBrowser.properties.displayStyle]: 'displayStyle';
    [dataBrowser.properties.elements]: 'elements';
    [dataBrowser.properties.emoji]: 'emoji';
    [dataBrowser.properties.image]: 'image';
    [dataBrowser.properties.imageUrl]: 'imageUrl';
    [dataBrowser.properties.max]: 'max';
    [dataBrowser.properties.maxFloat]: 'maxFloat';
    [dataBrowser.properties.messages]: 'messages';
    [dataBrowser.properties.min]: 'min';
    [dataBrowser.properties.minFloat]: 'minFloat';
    [dataBrowser.properties.nextPage]: 'nextPage';
    [dataBrowser.properties.numberFormatting]: 'numberFormatting';
    [dataBrowser.properties.preview]: 'preview';
    [dataBrowser.properties.publishedAt]: 'publishedAt';
    [dataBrowser.properties.replyTo]: 'replyTo';
    [dataBrowser.properties.resources]: 'resources';
    [dataBrowser.properties.subResources]: 'subResources';
    [dataBrowser.properties.tableColumnWidths]: 'tableColumnWidths';
    [dataBrowser.properties.tags]: 'tags';
    [dataBrowser.properties.url]: 'url';
  }
}
