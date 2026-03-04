import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import {
  Client,
  core,
  isYDoc,
  server,
  urls,
  useCurrentAgent,
  useResource,
  useStore,
  YLoader,
  type JSONArray,
  type JSONValue,
  type PropVals,
  type Resource,
  type Store,
} from '@tomic/react';
import {
  MessageType,
  type PageContext,
  type RPCMessage,
  type Resource as UIPluginResource,
  type Commit as PluginCommit,
} from '@tomic/plugin';
import React, { useEffect, useRef } from 'react';
import { useCurrentSubject } from '@helpers/useCurrentSubject';
import { constructOpenURL } from '@helpers/navigation';
import { useResourcePicker, type PickResourceFn } from './useResourcePicker';
import { useFilePicker, type PickFileFn } from './useFilePicker';
import type { UIPluginData } from '@components/CustomViewProvider';
import {
  useRequestPermissionDialog,
  type RequestPermissionFn,
} from './useRequestPermissionDialog';

interface ConstructorArgs {
  context: PageContext;
  store: Store;
  iFrame: HTMLIFrameElement;
  pluginResource: Resource;
  navigate: (subject: string) => void;
  pickResource: PickResourceFn;
  pickFile: PickFileFn;
  requestReadPermission: RequestPermissionFn;
  requestWritePermission: RequestPermissionFn;
}

export class RPCServer {
  public context: PageContext;
  public store: Store;
  public iFrame: HTMLIFrameElement;
  public navigate: (subject: string) => void;
  public pickResource: PickResourceFn;
  public pickFile: PickFileFn;
  public requestReadPermission: RequestPermissionFn;
  public requestWritePermission: RequestPermissionFn;

  public pluginResource: Resource;

  private subscriptions: Map<string, (resource: Resource) => void> = new Map();

  constructor({
    context,
    store,
    iFrame,
    pluginResource,
    navigate,
    pickResource,
    pickFile,
    requestReadPermission,
    requestWritePermission,
  }: ConstructorArgs) {
    this.context = context;
    this.store = store;
    this.iFrame = iFrame;
    this.pluginResource = pluginResource;
    this.navigate = navigate;
    this.pickResource = pickResource;
    this.pickFile = pickFile;
    this.requestReadPermission = requestReadPermission;
    this.requestWritePermission = requestWritePermission;
    this.handleEvent = this.handleEvent.bind(this);
  }

  public startServer(): void {
    window?.addEventListener('message', this.handleEvent);

    // Re-subscribe to all existing subscriptions
    if (this.subscriptions.size > 0) {
      // eslint-disable-next-line no-console
      console.log(`Re-subscribing to ${this.subscriptions.size} resources`);

      for (const [subject, callback] of this.subscriptions.entries()) {
        this.store.subscribe(subject, callback);
      }
    }
  }

  public stopServer(): void {
    window?.removeEventListener('message', this.handleEvent);
    this.unsubscribeAll();
  }

  private handleEvent(event: MessageEvent): void {
    if (event.source !== this.iFrame.contentWindow) return;

    const message = event.data as RPCMessage;
    this.handleMessage(message);
  }

  private handleMessage(message: RPCMessage): void {
    switch (message.type) {
      case MessageType.GET_RESOURCE:
        this.handleGetResource(message);
        break;
      case MessageType.QUERY:
        this.handleQuery(message);
        break;
      case MessageType.COMMIT:
        this.handleCommit(message);
        break;
      case MessageType.SEARCH:
        this.handleSearch(message);
        break;
      case MessageType.GET_CONTEXT:
        this.handleGetContext(message);
        break;
      case MessageType.NAVIGATE:
        this.handleNavigate(message);
        break;
      case MessageType.PICK_RESOURCE:
        this.handlePickResource(message);
        break;
      case MessageType.PICK_FILE:
        this.handlePickFile(message);
        break;
      case MessageType.SUBSCRIBE:
        this.handleSubscribe(message);
        break;
      case MessageType.UNSUBSCRIBE:
        this.handleUnsubscribe(message);
        break;
      default:
        this.sendResponse(message, 'UNSUPPORTED MESSAGE');
    }
  }

  private async handleGetResource(
    message: RPCMessage<MessageType.GET_RESOURCE>,
  ): Promise<void> {
    const resource = await this.store.getResource(message.args.subject);

    if (!(await this.canPluginReadResource(resource))) {
      const allowed = await this.requestReadPermission(message.args.subject);

      if (!allowed) {
        this.sendError(
          message,
          'unauthorized',
          /* @wc-ignore */ 'Plugin does not have access to this resource.',
        );

        return;
      }
    }

    this.sendResponse(message, resourceToUIPluginResource(resource));
  }

  private async handleQuery(
    message: RPCMessage<MessageType.QUERY>,
  ): Promise<void> {
    this.sendResponse(message, 'not implemented');
  }

  private async handleCommit(
    message: RPCMessage<MessageType.COMMIT>,
  ): Promise<void> {
    const { commit } = message.args as { commit: PluginCommit };

    if (!commit || !commit.subject) {
      this.sendError(
        message,
        'invalid-args',
        /* @wc-ignore */ 'Commit subject is missing',
      );

      return;
    }

    const resource = await this.store.getResource(commit.subject);

    if (this.commitChangesPlugin(commit, resource)) {
      this.sendError(
        message,
        'unauthorized',
        /* @wc-ignore */ 'Plugin cannot edit plugin resources',
      );

      return;
    }

    if (!(await this.canPluginWriteResource(resource))) {
      const allowed = await this.requestWritePermission(commit.subject);

      if (!allowed) {
        this.sendError(
          message,
          'unauthorized',
          /* @wc-ignore */ 'Plugin does not have access to this resource.',
        );

        return;
      }
    }

    try {
      if (commit.set) {
        for (const [key, value] of Object.entries(commit.set)) {
          await resource.set(key, value as JSONValue);
        }
      }

      if (commit.remove) {
        for (const key of commit.remove as string[]) {
          resource.remove(key);
        }
      }

      if (commit.destroy) {
        await resource.destroy();
      } else {
        await resource.save();
      }

      this.sendResponse(message, { success: true });
    } catch (e) {
      this.sendError(message, 'commit-failed', e.message);
    }
  }

  private async handleSearch(
    message: RPCMessage<MessageType.SEARCH>,
  ): Promise<void> {
    this.sendResponse(message, 'not implemented');
  }

  private async handleGetContext(
    message: RPCMessage<MessageType.GET_CONTEXT>,
  ): Promise<void> {
    this.sendResponse(message, this.context);
  }

  private async handleNavigate(
    message: RPCMessage<MessageType.NAVIGATE>,
  ): Promise<void> {
    if (!Client.isValidSubject(message.args.subject)) {
      this.sendResponse(message, false);

      return;
    }

    this.sendResponse(message, true);
    this.navigate(constructOpenURL(message.args.subject));
  }

  private async handlePickResource(
    message: RPCMessage<MessageType.PICK_RESOURCE>,
  ): Promise<void> {
    const selected = await this.pickResource(message.args);

    if (!selected) {
      this.sendResponse(message, undefined);

      return;
    }

    const resource = await this.store.getResource(selected);

    this.sendResponse(message, resourceToUIPluginResource(resource));
  }

  private async handlePickFile(
    message: RPCMessage<MessageType.PICK_FILE>,
  ): Promise<void> {
    const selected = await this.pickFile(message.args);

    if (!selected) {
      this.sendResponse(message, undefined);

      return;
    }

    const resource = await this.store.getResource(selected);

    this.sendResponse(message, resourceToUIPluginResource(resource));
  }

  private async handleSubscribe(
    message: RPCMessage<MessageType.SUBSCRIBE>,
  ): Promise<void> {
    if (this.subscriptions.has(message.args.subject)) {
      return;
    }

    const r = await this.store.getResource(message.args.subject);

    if (!(await this.canPluginReadResource(r))) {
      const allowed = await this.requestReadPermission(message.args.subject);

      if (!allowed) {
        return;
      }
    }

    const callback = (resource: Resource) => {
      this.sendResourceNotification(resource);
    };

    this.subscriptions.set(message.args.subject, callback);

    this.store.subscribe(message.args.subject, callback);
  }

  private async handleUnsubscribe(
    message: RPCMessage<MessageType.UNSUBSCRIBE>,
  ): Promise<void> {
    const callback = this.subscriptions.get(message.args.subject);

    if (!callback) return;

    this.subscriptions.delete(message.args.subject);
    this.store.unsubscribe(message.args.subject, callback);
  }

  private unsubscribeAll() {
    for (const [subject, callback] of this.subscriptions.entries()) {
      this.store.unsubscribe(subject, callback);
    }
  }

  private sendResponse(message: RPCMessage, data: unknown): void {
    this.iFrame.contentWindow?.postMessage(
      {
        type: 'response',
        requestId: message.requestId,
        data,
      },
      '*',
    );
  }

  private sendError(
    message: RPCMessage,
    error: string,
    errorMessage?: string,
  ): void {
    this.iFrame.contentWindow?.postMessage(
      {
        type: 'error',
        requestId: message.requestId,
        error,
        message: errorMessage,
      },
      '*',
    );
  }

  private sendResourceNotification(resource: Resource): void {
    this.iFrame.contentWindow?.postMessage(
      {
        type: 'resource-notification',
        resource: resourceToUIPluginResource(resource),
      },
      '*',
    );
  }

  private async canPluginReadResource(resource: Resource): Promise<boolean> {
    const pluginAgent = this.pluginResource.get(server.properties.pluginAgent);

    const pageSubject = this.context.resource.subject;
    const pageClasses =
      (this.context.resource.props[core.properties.isA] as string[]) ?? [];

    const permittedRoots = [pageSubject, ...pageClasses];

    const canRead = (r: Resource): boolean => {
      if (permittedRoots.includes(r.subject)) {
        return true;
      }

      const parent = r.get(core.properties.parent);

      if (permittedRoots.includes(parent)) {
        return true;
      }

      if (
        r
          .get(core.properties.read)
          ?.some(
            agent =>
              agent === urls.instances.publicAgent || agent === pluginAgent,
          )
      ) {
        return true;
      }

      if (r.get(core.properties.write)?.includes(pluginAgent)) {
        return true;
      }

      return false;
    };

    if (canRead(resource)) {
      return true;
    }

    // Check if the resource is a child of the page resource or if any parent gives the plugin read rights.
    const parents = await this.store.getResourceAncestry(resource);

    for (const parent of parents) {
      const r = await this.store.getResource(parent);

      if (canRead(r)) {
        return true;
      }
    }

    return false;
  }

  private async canPluginWriteResource(resource: Resource): Promise<boolean> {
    const pluginAgent = this.pluginResource.get(server.properties.pluginAgent);

    const canWrite = (r: Resource): boolean => {
      if (r.subject === this.context.resource.subject) {
        return true;
      }

      const parent = r.get(core.properties.parent);

      if (parent === this.context.resource.subject) {
        return true;
      }

      if (r.get(core.properties.write)?.includes(pluginAgent)) {
        return true;
      }

      return false;
    };

    if (resource.subject === this.context.resource.subject) {
      return true;
    }

    if (canWrite(resource)) {
      return true;
    }

    // Check if the resource is a child of the page resource or if any parent gives the plugin write rights.
    const parents = await this.store.getResourceAncestry(resource);

    for (const parent of parents) {
      const r = await this.store.getResource(parent);

      if (canWrite(r)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if the commit changes a plugin resource to prevent plugins from updating themselves or other plugins.
   */
  private commitChangesPlugin(
    commit: PluginCommit,
    resource: Resource,
  ): boolean {
    if (resource.hasClasses(server.classes.plugin)) {
      return true;
    }

    if (
      commit.set &&
      Array.isArray(commit.set[core.properties.isA]) &&
      (commit.set[core.properties.isA] as JSONArray).includes(
        server.classes.plugin,
      )
    ) {
      return true;
    }

    if (
      commit.push &&
      Array.isArray(commit.push[core.properties.isA]) &&
      (commit.push[core.properties.isA] as JSONArray).includes(
        server.classes.plugin,
      )
    ) {
      return true;
    }

    return false;
  }
}

function resourceToUIPluginResource(resource: Resource): UIPluginResource {
  return {
    subject: resource.subject,
    title: resource.title,
    loading: false,
    props: propvalsToJSONRecord(resource.getPropVals()),
  };
}

function propvalsToJSONRecord(propvals: PropVals): Record<string, JSONValue> {
  return Object.fromEntries(
    propvals.entries().map(([key, value]) => {
      if (isYDoc(value)) {
        return [key, YLoader.Y.encodeStateAsUpdateV2(value)];
      }

      return [key, value];
    }),
  );
}

export function usePluginRPC(
  pluginData: UIPluginData,
): [React.RefObject<HTMLIFrameElement | null>, React.ReactNode] {
  const store = useStore();
  const navigate = useNavigateWithTransition();
  const [agent] = useCurrentAgent();
  const [currentSubject] = useCurrentSubject();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pluginResource = useResource(pluginData.resource);
  const currentResource = useResource(currentSubject);

  const [requestReadPermission, requestReadPermissionDialog] =
    useRequestPermissionDialog(pluginData.plugin, 'read');
  const [requestWritePermission, requestWritePermissionDialog] =
    useRequestPermissionDialog(pluginData.plugin, 'write');
  const [pickResource, resourcePickerDialog] = useResourcePicker(
    pluginData.plugin,
  );
  const [pickFile, filePickerDialog] = useFilePicker();

  const serverRef = useRef<RPCServer | undefined>(undefined);

  useEffect(() => {
    if (!frameRef.current) return;

    const context = {
      resource: resourceToUIPluginResource(currentResource.stable),
      agent: agent?.subject ?? '',
    };

    if (!serverRef.current) {
      serverRef.current = new RPCServer({
        context,
        store,
        iFrame: frameRef.current,
        pluginResource: pluginResource.stable,
        navigate,
        pickResource,
        pickFile,
        requestReadPermission,
        requestWritePermission,
      });
    } else {
      serverRef.current.context = context;
      serverRef.current.store = store;
      serverRef.current.iFrame = frameRef.current;
      serverRef.current.navigate = navigate;
      serverRef.current.pickResource = pickResource;
      serverRef.current.pickFile = pickFile;
      serverRef.current.requestReadPermission = requestReadPermission;
      serverRef.current.requestWritePermission = requestWritePermission;
      serverRef.current.pluginResource = pluginResource.stable;
    }
  }, [
    currentResource.stable,
    pluginResource.stable,
    store,
    navigate,
    pickResource,
    pickFile,
    agent?.subject,
    requestReadPermission,
    requestWritePermission,
  ]);

  useEffect(() => {
    serverRef.current?.startServer();

    return () => {
      serverRef.current?.stopServer();
    };
  }, []);

  return [
    frameRef,
    <>
      {resourcePickerDialog}
      {filePickerDialog}
      {requestReadPermissionDialog}
      {requestWritePermissionDialog}
    </>,
  ];
}
