import * as vscode from "vscode";

import { CollectionBuilder, core } from '@tomic/lib';
import { getStore } from './helpers/getStore'; 
import { learningRust, type BlogPost } from './ontologies/learningRust'; 
// --------- Create a Store ---------.
const store = getStore();

class AtomicContextProvider implements IContextProvider {
  get description(): ContextProviderDescription {
    return {
      title: "atomicserver",
      displayTitle: "AtomicServerSearch",
      description: "Reference item in AtomicServer using Atomic collections",
      type: "submenu",
    };
  }


  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    // 'query' is the filepath of the README selected from the dropdown
    // const content = "await extras.ide.readFile(query)";

    return [
      {
        name: await getAtomicResource(query),
        description: "Stuff",
        content:"Custom content",
      },
    ];
  }

  async loadSubmenuItems(
    args: LoadSubmenuItemsArgs,
  ): Promise<ContextSubmenuItem[]> {
    // search over all atomic server resources
    const blogCollection = new CollectionBuilder(store)
    .setProperty(core.properties.isA)
    .setValue(learningRust.classes.blogPost)
    .setSortBy(learningRust.properties.publishedAt)
    .setSortDesc(true)
    .build();

  var results = [];
  for await (const post of blogCollection) {
    const blogpost = await store.getResource<BlogPost>(post);
    results.push({
      id:blogpost.subject,
      title:blogpost.title,
      description:blogpost.props.description,
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
};




async function getAtomicResource(path: string): Promise<string> {
  const subject="https://common.terraphim.io/drive/h6grD0ID/ontology/learning-rust/folder/Untitled-Folder-gwetdrz3nk/folder/Untitled-Folder-2ttvqp7fteg";
  // --------- Get a resource ---------
  const gotResource = await store.getResource(subject);
  const atomString = gotResource.get(core.properties.name);
  return atomString ?? "";
}


export function activate(context: vscode.ExtensionContext) {
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

export function deactivate() {}