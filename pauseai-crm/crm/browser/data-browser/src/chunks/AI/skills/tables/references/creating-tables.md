# Creating Tables

## Step-by-Step Execution

## Step 1: Define the Properties

Create or identify the properties that will serve as columns.

- Class: <https://atomicdata.dev/classes/Property>
- Parent: Should be the Drive's defaultOntology.
- Shortname: Use a lowercase slug.
- Datatypes: Use appropriate types (See column types below).

Note: lean towards using the standard [name](https://atomicdata.dev/properties/name) property over custom name properties.

### Step 2: Create the Row Class

Create a Class that represents a single row in the table.

- Class: <https://atomicdata.dev/classes/Class>
- Parent: Should be the Drive's defaultOntology.
- Shortname: Use a lowercase slug.
- Recommends: A ResourceArray with the subjects of all the properties created in Step 1.

**IMPORTANT**: Do not include `createdAt` in the recommends or required list, even though rows require it for visibility. In Atomic Data resources are allowed to have additional properties that are not defined in the class. By not adding the `createdAt` property to the class we prevent the table from rendering it as a column and only using it for sorting.

### Step 3: Create the Table Resource

Create the actual Table resource in the desired location (usually the Drive root).

- Class: <https://atomicdata.dev/classes/Table>
- Name: The display name of the table (e.g., "Partners").
- Classtype: The subject of the Class created in Step 2.

### Step 4: Register in Ontology

To ensure the schema is discoverable, add the new Class and Properties to the Drive's Default Ontology resource.

Update the <https://atomicdata.dev/properties/classes> array.
Update the <https://atomicdata.dev/properties/properties> array.

## Critical Constraints

- Column Definition: Every property listed in the Class's recommends or requires arrays will appear as a column in the table.
- Naming: Shortnames for Classes and Properties must be valid slugs (lowercase, numbers, and dashes only).

## Column Types

The table editor supports a few different types of columns.
Here is a list of these types and what the underlying property looks like:

- Text: A property with a datatype of either `sting`, `markdown`, `slug` or `uri`.
- Number: A property with a datatype of `integer` or `float`.
- Date: A property with a datatype of `date` or `timestamp`.
- Checkbox: A property with a datatype of `boolean`.
- Select: A property with a datatype of `resourceArray`, a classtype of [tag](https://atomicdata.dev/classes/Tag) and allowsOnly set to a list of tags.
  - The select values should be tag resources with the property as parent.
- File: A property with a datatype of `atomicURL` and classtype set to [file](https://atomicdata.dev/classes/File).
- JSON: A property with a datatype of `json`.
- Relation: a property with a datatype of either `atomicURL` or `resourceArray`.
- Existing property: a property that already exists can also be used as a column.

Note: Datatypes are also resources and thus should be referenced by their subject e.g. `https://atomicdata.dev/datatypes/string`.
