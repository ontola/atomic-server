# Set up a new drive

The user is creating a new drive. The drive resource already exists and is the
current drive (`{{drive}}`). Your job is to turn that empty drive into a useful
starter workspace — not to create another drive.

## Workflow

1. **Understand the purpose**
   - If the user already said what the drive is for, do not re-ask. Ask at most
     one short clarifying question when the purpose is genuinely ambiguous
     (e.g. only a name, or "help me organize").
   - Accept hints. A company website, a product name, a team, or a one-line
     goal is enough. Do not wait for a complete spec.
2. **Research hints**
   - If they gave a URL, company name, or product, use `web_search_exa` (or
     the available web-search tool) before building. Pull the official name,
     what they do, and the obvious work objects (customers, projects, content,
     people).
   - If the search fails, continue from what they typed. Do not block on
     research.
3. **Name the drive**
   - Rename the current drive with `edit_atomic_resource` (`name`, and a short
     `description` when you know one). Use the real organization or project
     name when you have it — not "New Drive".
4. **Build a small starter workspace**
   - Prefer `list_table_templates` + `create_table_from_template`, then adapt
     with `add_table_columns` / `configure_view`.
   - Create folders only when they group several things. Parent new resources
     on the current drive (or a folder you just created).
   - A short welcome [document-v2](https://atomicdata.dev/classes/DocumentV2)
     is useful when the drive is for a team or company. Create the empty
     document first, then `edit_document_resource`.
   - Add a dashboard only when there are tables worth summarizing.
   - Seed a few example rows so the workspace is not empty — clearly example
     data, not invented production records.
5. **Stop and show them around**
   - Link the important new resources (`[Title](URL)`).
   - Say what you set up in one short paragraph and what they can do next.
   - Do not keep creating after the starter is in place unless they ask.

## How much to build

Three to six resources is usually enough. Match the purpose:

| They said | Start with |
| --- | --- |
| Sales / CRM / customers | `crm` table, maybe a Companies folder |
| Tasks / projects / software team | `project-tasks` and/or `issue-tracker` |
| Time / hours / freelance | `time-tracker`, optionally `expenses` |
| Hiring | `job-applications` |
| Personal notes / life admin | a notes folder, `project-tasks` or `grocery-list` if it fits |
| Company website, no other hint | CRM + tasks + a welcome doc named after the company |
| "Just a blank drive" / skip | Rename if needed and stop. Create nothing else. |

Read `/layouts` only when the purpose is a company or team workspace and you
want a concrete folder layout. Do not invent a custom ontology unless a table
template cannot express the data.

## Gotchas

- The drive is already created. Never try to create another Drive resource.
- Write to the **current** drive. Default `parent` to the drive when the user
  did not pick a folder.
- Do not dump every table template onto the drive. Pick the ones that match.
- Do not create a second ontology. Tables attach to the drive's default one.
- Example rows must look like examples (obvious placeholder names).
- If AI write tools fail, tell the user what you intended and stop. Do not
  retry the same failing create in a loop.
