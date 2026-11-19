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
Choose **Add to Drive** on GitHub. This installs a GitHub App with its provider
icon saved as a File in your drive. Reopening the App preserves your chosen icon.

Connect your GitHub account from the App. Your authenticated identity appears
directly beneath GitHub, alongside **Public**. There is no Accounts folder.
The identity comes from the catalog's Authenticated Principal declaration.

Open your account and choose a collection, such as **Organizations** or
**Repositories**. These are separate collections described by the API catalog;
Organizations contains organizations returned by GitHub, without synthetic
personal-owner rows. Choose **Open collection**, then **Sync now** in its
**Sync** tab to import its rows. The Repositories collection imports repositories
available to the connected account.

Use **+** to add **Syncable Collection** to a table. This native view shows saved
fields and **Open** actions. An organization opens its saved Repositories table;
a repository opens its saved **Issues and pull requests** table. Choose **Sync
now** there to fetch that selected collection. Opening or returning to a native
view makes no provider request. GitHub's Issues endpoint includes pull requests,
which remain visible with the API's optional Pull request field.

To link a public repository, open **Public** beneath GitHub. Select **Issues and
pull requests**, choose the repository source, and enter its owner and repository
name. **Open collection** resolves that source to its stable repository ID before
creating the table. This branch uses GitHub's public API without a GitHub account.

Sync starts from **Sync now** and continues while you browse other views or
resources in the app. Closing the app stops the run. **Pause** retains stored rows
and blocks refreshes until you resume. Paused status survives a reload; open the
**Sync** tab and choose **Resume** to enable syncing again. The **Sync** tab
contains controls and status; the **Table** tab follows the schema derived from
the API description.
**Syncable Collection** reads saved Atomic data and remains available during an
import or a provider outage. Changes you make in Atomic stay in your drive.
An interrupted import retains accepted rows. Moving a table within the same
drive retains its source identity.

For an older installation, choose **Open GitHub** from **Apps** to upgrade its
existing root in place and remove the extra Accounts navigation level. Migration
retains resource subjects and saved data; ambiguous historical bindings are
reported rather than guessed. Existing GitHub-specific view tabs open the
generic collection view; new tabs use **Syncable Collection**.

Your integration proxy must support client-held connection keys and have
GitHub OAuth configured. The
[collection-navigation IAP catalog](https://github.com/ontola/atomic-plugins/blob/main/overlays/catalog/2026-11-19-collection-navigation.json)
provides authenticated identity, collection schemas, public access and nested
navigation through CRUD references and standard OpenAPI response Links. Other
providers can use the same runtime when their catalog supplies those definitions.

## What is special about it

- **Apps only get what you approve.** They are installed with grants, and can be paused or removed at any time.
- **Your data stays yours.** An app writes to your drive, not to the server of its author.
- **You can build your own** in plain JavaScript (a module that exports a `view` function and draws into the frame), or extend the server with WebAssembly [plugins](../plugins.md). See [custom views](../plugins/custom-views.md).
