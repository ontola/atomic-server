import { type Core, type Resource } from '@tomic/lib';
import { store } from './store.js';
import { ReverseMapping } from './generateBaseObject.js';
import { PropertyRecord } from './PropertyRecord.js';
import { dedupe } from './utils.js';

interface GeneratedOutput {
  interfaces: string;
  webComponents: string;
}

export const generateClasses = (
  ontology: Resource<Core.Ontology>,
  reverseMapping: ReverseMapping,
  propertyRecord: PropertyRecord,
): GeneratedOutput => {
  const classes = dedupe(ontology.props.classes ?? []);

  const classStringList = classes.map(subject => {
    return generateClass(subject, reverseMapping, propertyRecord);
  });

  const webComponentsList = classes.map(subject => {
    return generateWebComponent(subject, reverseMapping, propertyRecord);
  });

  const innerStr = classStringList.join('\n');
  const webComponentsStr = webComponentsList.join('\n\n');

  return {
    interfaces: `interface Classes {
      ${innerStr}
    }`,
    webComponents: webComponentsStr,
  };
};

const generateClass = (
  subject: string,
  reverseMapping: ReverseMapping,
  propertyRecord: PropertyRecord,
): string => {
  const resource = store.getResourceLoading<Core.Class>(subject);

  const transformSubject = (str: string) => {
    const name = reverseMapping[str];

    if (!name) {
      return `'${str}'`;
    }

    return `typeof ${name}`;
  };

  const requires = resource.props.requires ?? [];
  const recommends = resource.props.recommends ?? [];

  for (const prop of [...requires, ...recommends]) {
    propertyRecord.reportPropertyUsed(prop);
  }

  return classString(
    reverseMapping[subject],
    requires.map(transformSubject),
    recommends.map(transformSubject),
  );
};

const generateWebComponent = (
  subject: string,
  reverseMapping: ReverseMapping,
  propertyRecord: PropertyRecord,
): string => {
  const resource = store.getResourceLoading<Core.Class>(subject);
  const className = reverseMapping[subject].split('.').pop() || '';
  const requires = resource.props.requires ?? [];
  const recommends = resource.props.recommends ?? [];
  const properties = [...requires, ...recommends];

  const kebabCaseName = className
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .toLowerCase();

  return `
class ${className}Element extends HTMLElement {
  static get observedAttributes() {
    return ['subject', ${properties
      .map(prop => `'${reverseMapping[prop]?.split('.').pop()}'`)
      .join(', ')}];
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
      ${properties
        .map(
          prop => `
      const ${reverseMapping[prop]?.split('.').pop()} = this._resource.get('${prop}');
      if (${reverseMapping[prop]?.split('.').pop()}) {
        this.setAttribute('${reverseMapping[prop]?.split('.').pop()}', ${reverseMapping[prop]?.split('.').pop()});
      }`,
        )
        .join('\n')}
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

    this.shadowRoot.innerHTML = \`
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
      <div class="atomic-resource \${loading ? 'loading' : ''}">
        ${properties
          .map(
            prop => `
        <div class="property">
          <span class="property-label">${reverseMapping[prop]?.split('.').pop()}:</span>
          <span class="property-value">\${this.getAttribute('${reverseMapping[prop]?.split('.').pop()}') || ''}</span>
        </div>`,
          )
          .join('\n')}
        ${requires
          .map(
            prop => `
        <div class="property error" style="display: \${!this.getAttribute('${reverseMapping[prop]?.split('.').pop()}') ? 'block' : 'none'}">
          Required: ${reverseMapping[prop]?.split('.').pop()}
        </div>`,
          )
          .join('\n')}
      </div>
    \`;
  }
}

customElements.define('atomic-${kebabCaseName}', ${className}Element);`;
};

const classString = (
  key: string,
  requires: string[],
  recommends: string[],
): string => {
  return `[${key}]: {
    requires: BaseProps${
      requires.length > 0 ? ' | ' + requires.join(' | ') : ''
    };
    recommends: ${recommends.length > 0 ? recommends.join(' | ') : 'never'};
  };`;
};
