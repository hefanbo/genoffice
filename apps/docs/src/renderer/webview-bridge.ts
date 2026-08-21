/**
 * When the docs renderer runs inside a VSCode webview (`acquireVsCodeApi` is
 * present), install `window.desktop` / `window.projectApi` backed by the
 * postMessage RPC bridge instead of the Electron preload globals. The channel
 * names mirror `apps/docs/src/preload/index.ts` exactly.
 */
import {
  base64ToArrayBuffer,
  bytesToBase64,
  createRpc,
  hasVsCodeApi,
} from '@genoffice/vscode-bridge'
import type { DesktopApi, OpenFileResult } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

function decodeOpenResult(r: unknown): OpenFileResult | null {
  if (!r) return null
  const o = r as { path: string; name: string; data: string; hash: string }
  return { path: o.path, name: o.name, data: base64ToArrayBuffer(o.data), hash: o.hash }
}

export function installWebviewBridge(): void {
  if (!hasVsCodeApi()) return
  const rpc = createRpc()

  const desktop = {
    // language / theme
    getLanguage: () => rpc.invoke('app:get-language'),
    onLanguageChanged: (handler: (lang: string) => void) => rpc.on('app:language-changed', handler),
    getTheme: () => rpc.invoke('app:get-theme'),
    onThemeChanged: (handler: (theme: string) => void) => rpc.on('app:theme-changed', handler),

    // open
    openDocx: async () => decodeOpenResult(await rpc.invoke('docs:open')),
    openDocxPath: async (path: string) => decodeOpenResult(await rpc.invoke('docs:open-path', path)),
    consumePendingOpenDocx: async () =>
      decodeOpenResult(await rpc.invoke('docs:consume-pending-open')),
    consumeNewBlankDoc: () => rpc.invoke('docs:consume-new-blank'),
    onOpenDocx: (handler: (result: OpenFileResult) => void) =>
      rpc.on('docs:opened', (result) => handler(decodeOpenResult(result)!)),
    onRenamedDocx: (handler: (paths: { oldPath: string; newPath: string }) => void) =>
      rpc.on('docs:renamed', handler),

    // password protection (docx encryption; the extension host does not port it)
    openDocxDecrypt: (path: string, password: string) =>
      rpc.invoke('docs:open-decrypt', path, password),
    setDocPassword: (filePath: string | null, password: string | null) =>
      rpc.invoke('docs:set-password', filePath, password),
    docPasswordIntentRevision: async () => {
      const revision: unknown = await rpc.invoke('docs:password-intent-revision')
      return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
        ? revision
        : 0
    },
    discardDocPasswordIntents: (throughRevision: number) =>
      rpc.invoke('docs:discard-password-intents', throughRevision),

    // save
    saveDocx: (path: string, data: ArrayBuffer, auto?: boolean) =>
      rpc.invoke('docs:save', path, bytesToBase64(data), auto === true),
    writeRecoveryCopy: (path: string, data: ArrayBuffer) =>
      rpc.invoke('docs:write-recovery', path, bytesToBase64(data)),
    setDirty: (dirty: boolean) => rpc.send('docs:dirty-changed', dirty),
    onTeardown: (handler: () => void) => rpc.on('docs:teardown', handler),
    saveDocxAs: (defaultName: string, data: ArrayBuffer) =>
      rpc.invoke('docs:save-as', defaultName, bytesToBase64(data)),
    saveDocxNew: (defaultName: string, data: ArrayBuffer) =>
      rpc.invoke('docs:save-new', defaultName, bytesToBase64(data)),

    // recent / images / fonts
    getRecentFiles: () => rpc.invoke('docs:recent'),
    pickImage: () => rpc.invoke('docs:pick-image'),
    fontMetrics: (family: string) => rpc.invoke('docs:font-metrics', family),

    // print / export
    print: () => rpc.invoke('docs:print'),
    exportPdf: (defaultName: string, w: number, h: number, outPath?: string) =>
      rpc.invoke('docs:export-pdf', defaultName, w, h, outPath),
    printPdfBuffer: (w: number, h: number) => rpc.invoke('docs:print-pdf-buffer', w, h),
    saveMergedPdf: (defaultName: string, parts: string[], outPath?: string) =>
      rpc.invoke('docs:save-merged-pdf', defaultName, parts, outPath),

    // AI
    getAiSettings: () => rpc.invoke('ai:get-settings'),
    setAiSettings: (settings: unknown) => rpc.invoke('ai:set-settings', settings),
    aiChat: (request: unknown) => rpc.invoke('ai:chat', request),
    aiStream: (request: unknown) => rpc.invoke('ai:stream', request),
    aiStreamCancel: (requestId: string) => rpc.invoke('ai:stream-cancel', requestId),
    aiGskStatus: (withEmail?: boolean) => rpc.invoke('ai:gsk-status', withEmail),
    aiGskLogin: () => rpc.invoke('ai:gsk-login'),
    webSearch: (query: string, maxResults?: number) =>
      rpc.invoke('ai:web-search', query, maxResults),
    imageSearch: (query: string, maxResults?: number) =>
      rpc.invoke('ai:image-search', query, maxResults),
    fetchImage: (url: string) => rpc.invoke('ai:fetch-image', url),

    // attachments
    pickAttachments: () => rpc.invoke('files:pick'),
    addAttachmentPaths: (paths: string[]) => rpc.invoke('files:add', paths),
    addPastedImage: (data: ArrayBuffer, ext: string) =>
      rpc.invoke('files:add-pasted-image', bytesToBase64(data), ext),
    readAttachment: (path: string, offset: number, maxChars: number) =>
      rpc.invoke('files:read', path, offset, maxChars),
    readAttachmentImage: (path: string) => rpc.invoke('files:read-image', path),
    getPathForFile: () => '',

    // tabs
    openNewTab: (openPath?: string | null) => rpc.invoke('win:new', openPath ?? null),
    listDocsTabs: () => rpc.invoke('win:list'),
    focusDocsTab: (id: string) => rpc.invoke('win:focus', id),

    // events
    onAiStream: (handler: (chunk: unknown) => void) => rpc.on('ai:stream-chunk', handler),
    onMenuCommand: (handler: (command: string, payload?: string) => void) =>
      rpc.on('menu:command', handler),
    onCloseCheck: (handler: () => void) => rpc.on('docs:close-check', handler),
    reportCloseCheck: (state: unknown) => rpc.send('docs:close-check-result', state),
    onCloseSaveRequest: (handler: () => void) => rpc.on('docs:close-save-request', handler),
    reportCloseSaveResult: (ok: boolean) => rpc.send('docs:close-save-result', ok === true),
    reportViewMenuState: (state: unknown) => rpc.send('docs:view-menu-state', state),
  } as unknown as DesktopApi

  const projectApi = {
    resolveChat: (args: unknown) => rpc.invoke('project:resolveChat', args),
    appendChat: (args: unknown) => rpc.invoke('project:appendChat', args),
    loadChat: (args: unknown) => rpc.invoke('project:loadChat', args),
    rebindChat: (args: unknown) => rpc.invoke('project:rebindChat', args),
    listProjects: () => rpc.invoke('project:list'),
    createProject: (args: unknown) => rpc.invoke('project:create', args),
    renameProject: (args: unknown) => rpc.invoke('project:rename', args),
    deleteProject: (args: unknown) => rpc.invoke('project:delete', args),
    moveFile: (args: unknown) => rpc.invoke('project:moveFile', args),
    getTimeline: (args: unknown) => rpc.invoke('project:timeline', args),
  } as unknown as ProjectApi

  window.desktop = desktop
  window.projectApi = projectApi
}
