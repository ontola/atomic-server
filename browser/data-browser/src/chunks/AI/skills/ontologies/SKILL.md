# Create Ontology

This skill provides a systematic procedure for building a formal Atomic Data Ontology. An ontology groups related Classes and Properties to describe a specific domain.

## Workflow / Procedure

1. **Check if a new ontology is needed**:
   - See if there is an existing ontology on the drive that is a good fit for the new schema, use the `query` tool for this (`where: [{property: 'https://atomicdata.dev/properties/isA', value: 'https://atomicdata.dev/class/ontology'}]`)
   - When querying, make sure to select the description property so you can read what each ontology is about.
   - If there is no good fit, ask the user if they want a new ontology or use the drives default ontology (can be found on the drive resource).

   **When creating a new ontology:**
   - Create a resource of class [Ontology](https://atomicdata.dev/class/ontology) first.
   - This resource will serve as the `parent` for all subsequent Classes and Properties.
   - Give it a fitting shortname and description.
2. **Create Classes**:
   - Define classes using the [Class](https://atomicdata.dev/classes/Class) class.
   - Give the class a fitting shortname and description.
   - Set the `parent` to the subject of the Ontology from step 1.
   - Do not add the properties yet as you have not created these.
3. **Create Properties**:
   - Define all custom properties using the [Property](https://atomicdata.dev/classes/Property) class.
   - Set the `parent` to the subject of the Ontology from step 1.
   - Give the property a fitting shortname and description.
   - Properties should have a fitting datatype, read the section about datatypes to see what datatypes are available.
   - **Classtype Recommendation**: For `resourceArray` or `atomicURL` datatypes, set a `classtype` if the property is intended to point to a specific Class. Omit it only if the property needs to support multiple different resource types.
4. **Update the classes**:
   - Update the classes's `requires` and `recommends` arrays with the subjects of the Properties created in step 3 or any existing properties that the class should use.
5. **Finalize the Ontology**:
   - Update the Ontology resource's `classes` and `properties` arrays with the subjects created in steps 2 and 3.
6. **Suggest further improvements**:
   When you are done creating the schema, see if there are any improvements that can be made and suggest them to the user.
   If you feel like the schema is missing important components, ask the user if they want you to add these.

## Gotchas

- **Slug Validation**: Shortnames MUST be lowercase with dashes (no CamelCase).
- **Parenting**: By creating the Ontology first, you ensure all metadata is neatly contained within the ontology's hierarchy from the start.
- **Strictness vs. Flexibility**: Use `classtype` to improve the editing UX for specific relations, but leave it empty for generic "any resource" relations.
- **Reuse Existing Properties**: Properties can be used by multiple classes. Do not create two properties for the same thing unless they mean something different. For example a `book` and `article` class can share the same `author` property but should probably not reuse it to refer to the director on a `movie` class.
- **Prefer standard properties** There are some standard properties in atomic that are prefered over more specific custom properties. These are [name](https://atomicdata.dev/properties/name) (string), [shortname](https://atomicdata.dev/properties/shortname) (slug), [image](https://atomicdata.dev/ontology/data-browser/property/image) (atomicURL pointing to a file resource) and [description](https://atomicdata.dev/properties/description) (markdown). When these are used the UI will automatically use these properties as the resource's title, description etc.
- **Search Before Create**: Never assume the drive is empty. Always search for existing Ontologies, Classes, and Properties that might match the user's needs before creating new ones.
- **Don't predict new subjects**: Resources created by the `create_resource` tool will be assigned a random subject, you can not predict this beforehand and should thus wait to use it until you've actually created the resource.

## Datatypes

There are several datatypes available in Atomic Data. In Atomic, datatypes are resources and thus should be referenced by their subject e.g. `https://atomicdata.dev/datatypes/string`.
Their subject always follow the pattern `https://atomicdata.dev/datatypes/<datatype>`.

Here is a list of the available datatypes:

- `string`: A basic string.
- `markdown`: A string with markdown support. Favour this type over string for properties that will contain long text.
- `slug`: A string limited to lowercase letters and dashes.
- `uri`: A string that must be a valid URI. Rendered as a link in the UI.
- `integer`: A signed integer.
- `float`: A 64 bit decimal number.
- `boolean`: A true or false value.
- `date`: An ISO date (YYYY-MM-DD) without time.
- `timestamp`: A timestamp (milliseconds since unix epoch).
- `resourceArray`: reference to multiple resources by their subjects.
- `atomicURL`: reference to another resource by its subject.
- `json`: A JSON object.
- `ydoc`: A YDoc object, Should not be used in most cases.

## Creating enums

If you need to create an enum property (a property with a fixed set of allowed values), you can use the `allows-only` property.
Create a property with a datatype of `atomicUrl` and set the `allows-only` property to the subjects of the allowed values.
Usually it's best to use [tag](https://atomicdata.dev/classes/Tag) resources as values but it's perfectly valid to use other types for enum values if you need something more complex.
When creating the value resources, make sure to add them to the `instances` array of the ontology.

## Relevant schemas

Here schemas for `class`, `property` and `ontology` so you don't need to look them up.

### Class

```json
{
  "subject": "https://atomicdata.dev/classes/Class",
  "shortname": "class",
  "description": "A Class describes an abstract concept, such as 'Person' or 'Blogpost'. It describes the data shape of data (which fields are required and recommended) and explains what the concept represents. It is convention to use Uppercase in its URL.Resources use the [is-a](https://atomicdata.dev/properties/isA) attribute to indicate which classes they are instances of. Note that in Atomic Data, a Resource can have several Classes - not just a single one.",
  "required": [
    {
      "subject": "https://atomicdata.dev/properties/shortname",
      "shortname": "shortname",
      "datatype": "https://atomicdata.dev/datatypes/slug"
    },
    {
      "subject": "https://atomicdata.dev/properties/description",
      "shortname": "description",
      "datatype": "https://atomicdata.dev/datatypes/markdown"
    }
  ],
  "recommended": [
    {
      "subject": "https://atomicdata.dev/properties/recommends",
      "shortname": "recommends",
      "datatype": "https://atomicdata.dev/datatypes/resourceArray"
    },
    {
      "subject": "https://atomicdata.dev/properties/requires",
      "shortname": "requires",
      "datatype": "https://atomicdata.dev/datatypes/resourceArray"
    }
  ]
}
```

### Property

```json
{
  "subject": "https://atomicdata.dev/classes/Property",
  "shortname": "property",
  "description": "A Property is a single field in a Class. It's the thing that a property field in an Atom points to. An example is `birthdate`. An instance of Property requires various Properties, most notably a `datatype` (e.g. `string` or `integer`), a human readable `description` (such as the thing you're reading), and a `shortname`.",
  "required": [
    {
      "subject": "https://atomicdata.dev/properties/shortname",
      "shortname": "shortname",
      "datatype": "https://atomicdata.dev/datatypes/slug"
    },
    {
      "subject": "https://atomicdata.dev/properties/datatype",
      "shortname": "datatype",
      "datatype": "https://atomicdata.dev/datatypes/atomicURL"
    },
    {
      "subject": "https://atomicdata.dev/properties/description",
      "shortname": "description",
      "datatype": "https://atomicdata.dev/datatypes/markdown"
    }
  ],
  "recommended": [
    {
      "subject": "https://atomicdata.dev/properties/classtype",
      "shortname": "classtype",
      "datatype": "https://atomicdata.dev/datatypes/atomicURL"
    },
    {
      "subject": "https://atomicdata.dev/properties/allowsOnly",
      "shortname": "allows-only",
      "datatype": "https://atomicdata.dev/datatypes/resourceArray"
    }
  ]
}
```
