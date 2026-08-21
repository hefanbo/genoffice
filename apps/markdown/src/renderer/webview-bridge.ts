/**
 * VSCode webview bridge for the markdown editor. Channel names mirror
 * `apps/markdown/src/preload/index.ts` and `../shared/ipc.ts`.
 */
import { createRpc, hasVsCodeApi } from '@genoffice/vscode-bridge'
import type { MarkdownApi } from '../shared/ipc'
import type { ProjectApi } from '@genoffice/project-store'

export function installWebviewBridge(): void {
  if (!hasVsCodeApi()) return
  const rpc = createRpc()

  const markdownApi = {
    consumePending: () => rpc.invoke('markdown:consume-pending'),
    readFile: (path: string) => rpc.invoke('markdown:read-file', path),
    save: (request: unknown) => rpc.invoke('markdown:save', request),
    setDirty: (dirty: boolean) => rpc.send('markdown:dirty-changed', dirty),
    onSaveRequest: (handler: (mode: string) => void) => rpc.on('markdown:save-request', handler),
    sendSaveRequestAck: (ok: boolean) => rpc.send('markdown:save-request-ack', ok),
    onCloseSaveRequest: (handler: () => void) => rpc.on('markdown:close-save-request', handler),
    sendCloseSaveResult: (ok: boolean) => rpc.send('markdown:close-save-result', ok),
    onFileRenamed: (handler: (newPath: string) => void) => rpc.on('markdown:file-renamed', handler),
    pickImage: () => rpc.invoke('markdown:pick-image'),
    saveImage: (data: unknown) => rpc.invoke('markdown:save-image', data),
    readImage: (src: string) => rpc.invoke('markdown:read-image', src),
    onExportRequest: (handler: (format: string) => void) => rpc.on('markdown:export-request', handler),
    onPrintRequest: (handler: () => void) => rpc.on('markdown:print-request', handler),
    exportDocx: (request: unknown) => rpc.invoke('markdown:export-docx', request),
    exportPdf: (request: unknown) => rpc.invoke('markdown:export-pdf', request),
    getLanguage: () => rpc.invoke('app:get-language'),
    onLanguageChanged: (handler: (lang: string) => void) => rpc.on('app:language-changed', handler),
    getTheme: () => rpc.invoke('app:get-theme'),
    onThemeChanged: (handler: (theme: string) => void) => rpc.on('app:theme-changed', handler),
    getAiSettings: () => rpc.invoke('ai:get-settings'),
    aiStream: (request: unknown) => rpc.invoke('ai:stream', request),
    aiStreamCancel: (requestId: string) => rpc.invoke('ai:stream-cancel', requestId),
    onAiStream: (handler: (chunk: unknown) => void) => rpc.on('ai:stream-chunk', handler),
    webSearch: (query: string, maxResults?: number) => rpc.invoke('ai:web-search', query, maxResults),
  } as unknown as MarkdownApi

  const projectApi = {
    resolveChat: (args: unknown) => rpc.invoke('project:resolveChat', args),
    appendChat: (args: unknown) => rpc.invoke('project:appendChat', args),
    loadChat: (args: unknown) => rpc.invoke('project:loadChat', args),
    rebindChat: (args: unknown) => rpc.invoke('project:rebindChat', args),
  } as unknown as ProjectApi

  window.markdownApi = markdownApi
  window.projectApi = projectApi
}
