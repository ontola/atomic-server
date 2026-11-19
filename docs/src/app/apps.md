# Apps

A workspace never has exactly the screens you need.
A habit tracker, a recipe box, a timesheet: too small for a product, too useful to go without.

An *app* is a small piece of software that runs inside your drive, in its own frame, and keeps its data in a table of its own.
Because that data is a normal table, you can still sort it, link to it and share it.

![An app called Team tasks, open in its own frame next to the drive sidebar](../assets/app/apps.png)

## Getting started

Offline there is no catalog to browse.
Press *New app* to create an app, and it opens in its own frame.
Where a catalog is available, you can also install apps from it, and you see what an app asks for before it is saved.

The app in the picture is a dashboard over the *Tasks* table: progress bar, counts per status, work per person and what is due next.
It is one JavaScript file that reads the rows of the table and draws them.
It only reads, so the table and the dashboard cannot disagree.
Ask the [AI chat](ai-chat.md) to build one, or write the file yourself.

An app can also add a view to a table, next to Kanban and Calendar.
It is then one more way to look at rows you already have.

## Import GitHub issues

From My Drive, open the account menu and choose **Apps**. Turn on **Show
experimental plugins** to see services from your configured integration proxy.
Choose **Add to Drive** on GitHub. This installs a GitHub App with an **Accounts**
table beneath it. Its icon comes from the proxy's public API metadata and is
saved as a File in your drive. Reopening the App preserves your chosen icon.

Connect your GitHub account from the App. Choose **Browse organizations**, then
**Refresh list** in **Sync** to discover your organization and personal owner
namespaces. Use **+** to add **Syncable Collection** to the table. This view
shows the kinds, counts and **Open** actions saved in Atomic. Open an owner to
reach its repositories table, where you can add the same **Syncable Collection**
view. Opening or returning to these views makes no GitHub request.

To import issues, open the repositories table's **Sync** tab, select a repository
and choose **Sync issues**. In the resulting Issues table, choose **Sync now** to
import issues. The **Table** view shows the imported rows. Run Sync again to
update changed rows. **Pause** keeps the rows in your drive and prevents
refreshes until you resume. Once the Issues table exists, **Open** on its saved
repository row takes you there. Discover later changes with **Refresh list**
in **Sync**.

To link a public repository, choose **Public repositories** in the GitHub App.
Enter its `owner/repo` name and choose **Link repository**.
The Issues table appears under the App's **Accounts → Public** branch in the sidebar. This
branch reads from GitHub's public API and works without a GitHub account.

Sync starts from **Sync now** and continues while you browse other views or
resources in the app. Closing the app stops the run. The **Sync** view contains
controls and status; the **Table** view follows the stored schema.
**Syncable Collection** is an ordinary native view of saved data. It stays
available while an import runs or the provider is unavailable. Its labels and
fields come from stored collection metadata, so it can also display collections
from other services that supply that metadata.
Changes you make in Atomic stay in your drive. An interrupted or incomplete import keeps cached issues.
Moving an Issues table within the same drive keeps its source binding.

For an older installation, choose **Open GitHub** from **Apps** to upgrade its
existing root table to an App. Its subject, saved accounts and source identities
are retained. Existing GitHub-specific view tabs open the generic collection
view; new tabs use **Syncable Collection**.

Your integration proxy must support client-held connection keys and have
GitHub OAuth configured. The
[Syncables Apps catalog](https://github.com/ontola/atomic-plugins/blob/main/overlays/catalog/2026-11-18-syncables-apps.json)
includes the collection descriptions and schema labels used by this flow.
Older catalogs may lack these views or show only owners of repositories visible
to your account.

## What is special about it

- **Apps only get what you approve.** They are installed with grants, and can be paused or removed at any time.
- **Your data stays yours.** An app writes to your drive, not to the server of its author.
- **You can build your own** in plain JavaScript (a module that exports a `view` function and draws into the frame), or extend the server with WebAssembly [plugins](../plugins.md). See [custom views](../plugins/custom-views.md).
