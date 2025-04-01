# AI Features in AtomicServer

AtomicServer offers powerful AI capabilities to help you automate tasks, generate content, and interact with your data in new ways.
It is also just a great general purpose AI client.
And if you want nothing to do with AI, you can disable it completely in the settings.

![AI Sidebar](../../assets/ui-guide/ai_sidebar_example.avif)

AtomicServer integrates with large language models (LLMs) via two main providers:

- **OpenRouter**: A cloud-based API that gives access to a wide range of commercial and open-source models (e.g., GPT-4, Claude, Mixtral, etc.).
- **Ollama**: A self-hosted, local LLM server that runs models on your own hardware for privacy and offline use.

## Configuring AI

Before you start using the AI features you will need to configure an AI provider. This is straightforward and can be done on the settings page.

### OpenRouter

If you want to use OpenRouter, you will need an OpenRouter account with some credits. You can link it to AtomicServer by clicking the "Login with OpenRouter" button or pasting your API key in the text field.

### Ollama

Download and install [Ollama](https://ollama.ai/download) for your desired OS.
Download some models from the terminal by entering.

```bash
ollama pull <model-name>
```

Next start the server:

```bash
ollama serve
```

Now in your AtomicServer go to the settings page, scroll down to the AI settings and under "AI Providers" click on Ollama.
There you can enter the URL of your Ollama server.
If you are running this server on the same machine as your browser, you can use `http://localhost:11434/api` as the URL.
Next you need to configure an agent to use the model. To do this go to an AI chat or open the AI sidebar and click on the agent in the chat input.
Click on the edit button and change the model to your desired Ollama model.

## Using AI

### AI Sidebar

The fastest way to use AI is with the AI sidebar. Open it by clicking on the ✨ button in the top right corner.
Chats in the AI sidebar do not persist and not shared with other users.
If you want to save your chat for later reference or to continue at a later point, you can save the chat as a resource by hitting the save button in the top right corner.
Once saved the chat can be used like any other resource, you can share it with other users and reference it in other resources.

### Creating an AI Chat resource.

You can also create AI chat resources without going through the AI sidebar first.
To create a full page AI chat that persists, create a new resource and click the `✨ ai-chat` button.

## Referencing resources in the chat

You can reference any resource in the chat by typing the `@` symbol and continue typing the name of the resource.
The resource data will then be added to the chat as context.
This way you can also reference resources from your MCP servers.

![Referencing resources in the chat](../../assets/ui-guide/adding-context-to-chat.avif)

## AI Agents

When you chat with an llm, the llm will act as a certain agent. By default this agent is the Atomic Assistant who helps you with AtomicServer stuff like answering questions about your data or searching and editing resources.
There is also a general purpose agent that doesn't have any instructions for if you just want to use it as a general purpose AI client.
To switch between agents, click on the agent in the chat input.
In the agent configuration dialog you can edit and create new agents, set an agent as the default or toggle the automatic agent selection.
The default agents, Atomic Data Agent and General Agent, are also editable so if you want to change how they work or what model they use feel free to do so.

### Creating Your Own Agents

You can also create your own agents that have their own system prompt, tool list and model.

![Creating an agent](../../assets/ui-guide/creating-an-ai-agent.avif)

### Automatic Agent Selection

AtomicServer features **automatic agent selection**.
To enable this, click on the agent in the chat input and check "Automatic agent selection".
AtomicServer will now automatically select the most relevant agent based on the context of the chat.
It will look at the agent's name, description and tools to determine the most relevant agent so make sure to give your agents a good name and description.

## MCP tools and resources

You can add MCP servers to your AtomicServer client.
To add an MCP server to your client, go to the settings page and under "MCP Servers" you can add new servers.

![Adding an MCP server](../../assets/ui-guide/adding-mcp-servers.avif)

Next you need to enable the tools for the agent you want to use them with.
This can be done by editing the agent and checking any mcp server you want it to have.

![Enabling MCP tools](../../assets/ui-guide/enabling-tools.avif)

Your agent will now be able to call the tools of the MCP server.

### MCP Resources

If one of your MCP servers has resources you can reference them in the chat by typing the `@` and selecting the server from the list.
Then continue typing the name of the resource you want to add to the context.

### How to use STDIO MCP servers

AtomicServer does not support mcp over stdio because the browser cannot access stdio.
If you want to use an MCP server that only supports stdio you can use tools like [Supergateway](https://github.com/supercorp-ai/supergateway) to convert stdio to Streamable HTTP or SSE.

Example:

```bash
npx -y supergateway \
    --stdio "<MCP_SERVER_COMMAND>" \
    --outputTransport streamableHttp --stateful \
    --sessionTimeout 60000 --port <PORT>
```
