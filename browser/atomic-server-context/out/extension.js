"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
const lib_1 = require("@tomic/lib");
const getStore_1 = require("./helpers/getStore");
const learningRust_1 = require("./ontologies/learningRust");
// --------- Create a Store ---------.
const store = (0, getStore_1.getStore)();
class AtomicContextProvider {
    get description() {
        return {
            title: "atomicserver",
            displayTitle: "AtomicServerSearch",
            description: "Reference item in AtomicServer using Atomic collections",
            type: "submenu",
        };
    }
    async getContextItems(query, extras) {
        // 'query' is the filepath of the README selected from the dropdown
        // const content = "await extras.ide.readFile(query)";
        return [
            {
                name: await getAtomicResource(query),
                description: "Stuff",
                content: "Custom content",
            },
        ];
    }
    async loadSubmenuItems(args) {
        // search over all atomic server resources
        const blogCollection = new lib_1.CollectionBuilder(store)
            .setProperty(lib_1.core.properties.isA)
            .setValue(learningRust_1.learningRust.classes.blogPost)
            .setSortBy(learningRust_1.learningRust.properties.publishedAt)
            .setSortDesc(true)
            .build();
        var results = [];
        for await (const post of blogCollection) {
            const blogpost = await store.getResource(post);
            results.push({
                id: blogpost.subject,
                title: blogpost.title,
                description: blogpost.props.description,
            });
        }
        results.push({
            id: "item1",
            title: await getAtomicResource("1"),
            description: "Description for Item 1",
        });
        console.log(results);
        return results;
    }
}
;
async function getAtomicResource(path) {
    const subject = "https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/folder/Untitled-Folder-gwetdrz3nk/folder/Untitled-Folder-2ttvqp7fteg";
    // --------- Get a resource ---------
    const gotResource = await store.getResource(subject);
    const atomString = gotResource.get(lib_1.core.properties.name);
    return atomString ?? "";
}
function activate(context) {
    console.log('Congratulations, your extension "atomic-server-context" is now active!');
    // get Continue extension using vscode API
    const continueExt = vscode.extensions.getExtension("continue.continue");
    // get the API from the extension
    const continueApi = continueExt?.exports;
    // register your custom provider
    continueApi?.registerCustomContextProvider(AtomicContextProvider);
    // modifyConfig(continueApi?.config);
    let disposable = vscode.commands.registerCommand('atomic-server-context.enableAtomicServerContext', () => {
        vscode.window.showInformationMessage('Atomic Server Context enabled');
        // continueApi?.registerCustomContextProvider(AtomicContextProvider);
    });
    context.subscriptions.push(disposable);
}
function deactivate() { }
//# sourceMappingURL=extension.js.map