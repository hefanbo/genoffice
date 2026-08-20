import * as vscode from 'vscode'
import { basename, dirname } from 'node:path'
import { createBridgeHost, type BridgeHandler } from '@genoffice/vscode-bridge'
import { base64ToBytes, bytesToBase64, mapVscodeLanguage, readFileBytes, writeFileBytes } from '../services/util'
import { currentTheme } from '../services/theme'
import { AiSettingsStore } from '../services/ai-settings'

const VIEW_TYPE = 'genoffice.markdown'

class MarkdownDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri
  constructor(uri: vscode.Uri) {
    this.uri = uri
  }
  dispose() {}
}

class MarkdownEditor {
  readonly bridge: ReturnType<typeof createBridgeHost>
  readonly panel: vscode.WebviewPanel
  readonly document: MarkdownDocument

  private initialConsumed = false
  private saveWaiters: Array<() => void> = []
  private pendingSaveAsTarget: vscode.Uri | null = null

  constructor(
    document: MarkdownDocument,
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    aiSettings: AiSettingsStore,
    private onDidEdit: () => void,
  ) {
    this.document = document
    this.panel = panel
    this.bridge = createBridgeHost((msg) => panel.webview.postMessage(msg), buildHandlers(this, context, aiSettings))
  }

  consumeInitial(): string | null {
    if (this.initialConsumed) return null
    this.initialConsumed = true
    return this.document.uri.fsPath
  }

  markEdited(): void {
    this.onDidEdit()
  }

  setSaveAsTarget(uri: vscode.Uri | null): void {
    this.pendingSaveAsTarget = uri
  }

  getPendingSaveAsTarget(): vscode.Uri | null {
    return this.pendingSaveAsTarget
  }

  waitForSave(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        resolve()
      }
      const timer = setTimeout(finish, timeoutMs)
      this.saveWaiters.push(() => {
        clearTimeout(timer)
        finish()
      })
    })
  }

  signalSaved(): void {
    for (const w of this.saveWaiters.splice(0)) w()
  }

  handle(raw: unknown): void {
    this.bridge.handle(raw)
  }

  broadcastSaveRequest(mode: 'save' | 'saveAs'): void {
    this.bridge.broadcast('markdown:save-request', mode)
  }

  broadcastTheme(theme: 'light' | 'dark'): void {
    this.bridge.broadcast('app:theme-changed', theme)
  }

  dispose(): void {
    // no-op teardown for markdown
  }
}

function buildHandlers(
  editor: MarkdownEditor,
  context: vscode.ExtensionContext,
  aiSettings: AiSettingsStore,
): BridgeHandler {
  const docDir = (): vscode.Uri => vscode.Uri.file(dirname(editor.document.uri.fsPath))

  const assetsDir = (): vscode.Uri | null => {
    if (editor.document.uri.scheme !== 'file') return null
    return vscode.Uri.joinPath(docDir(), 'assets')
  }

  return {
    // ---- open ----
    'markdown:consume-pending': () => editor.consumeInitial(),
    'markdown:read-file': async (path: string) => {
      const bytes = await readFileBytes(vscode.Uri.file(path))
      return Buffer.from(bytes).toString('utf8')
    },

    // ---- save ----
    'markdown:save': async (request: { text: string; mode: 'save' | 'saveAs'; suggestedName?: string }) => {
      try {
        let target: vscode.Uri
        if (request.mode === 'saveAs') {
          target = editor.getPendingSaveAsTarget()!
          if (!target) {
            const picked = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(request.suggestedName ?? 'untitled.md'),
              filters: { Markdown: ['md'] },
            })
            if (!picked) return { ok: true, canceled: true }
            target = picked
          }
        } else {
          target = editor.document.uri
        }
        await writeFileBytes(target, Buffer.from(request.text, 'utf8'))
        editor.setSaveAsTarget(null)
        editor.signalSaved()
        return { ok: true, path: target.fsPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    'markdown:dirty-changed': (dirty: boolean) => {
      if (dirty) editor.markEdited()
    },
    'markdown:save-request-ack': () => {},
    'markdown:close-save-result': () => {},

    // ---- images ----
    'markdown:pick-image': async () => {
      const dir = assetsDir()
      if (!dir) return null
      const picked = await vscode.window.showOpenDialog({
        filters: { Images: ['png', 'jpg', 'jpeg', 'gif'] },
        canSelectMany: false,
      })
      if (!picked || picked.length === 0) return null
      const bytes = await readFileBytes(picked[0])
      await vscode.workspace.fs.createDirectory(dir)
      const name = basename(picked[0].fsPath)
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), bytes)
      return `assets/${name}`
    },
    'markdown:save-image': async (data: { base64: string; ext: string }) => {
      const dir = assetsDir()
      if (!dir) return null
      const bytes = base64ToBytes(data.base64)
      await vscode.workspace.fs.createDirectory(dir)
      const name = `image-${Date.now()}.${data.ext}`
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, name), bytes)
      return `assets/${name}`
    },
    'markdown:read-image': async (src: string) => {
      try {
        const target = vscode.Uri.joinPath(docDir(), src)
        const bytes = await readFileBytes(target)
        const ext = src.split('.').pop()?.toLowerCase() ?? 'png'
        return { base64: bytesToBase64(bytes), mime: ext === 'jpg' ? 'image/jpeg' : `image/${ext}` }
      } catch {
        return null
      }
    },

    // ---- export ----
    'markdown:export-docx': async (request: { base64: string; suggestedName: string; mode: 'dialog' | 'openInDocs' }) => {
      try {
        const bytes = base64ToBytes(request.base64)
        let target: vscode.Uri
        if (request.mode === 'dialog') {
          const picked = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${request.suggestedName}.docx`),
            filters: { 'Word document': ['docx'] },
          })
          if (!picked) return { ok: true, canceled: true }
          target = picked
        } else {
          target = vscode.Uri.joinPath(docDir(), `${request.suggestedName}.docx`)
        }
        await writeFileBytes(target, bytes)
        if (request.mode === 'openInDocs') {
          await vscode.commands.executeCommand('vscode.open', target)
        }
        return { ok: true, path: target.fsPath }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    'markdown:export-pdf': () => ({ ok: false, error: 'export-pdf not implemented' }),

    // ---- language / theme ----
    'app:get-language': () => mapVscodeLanguage(vscode.env.language),
    'app:get-theme': () => currentTheme(),

    // ---- AI (deferred: see plan Phase 4) ----
    'ai:get-settings': () => aiSettings.get(),
    'ai:set-settings': (settings: unknown) => aiSettings.set(settings as never),
    'ai:stream': async () => {},
    'ai:stream-cancel': async () => {},
    'ai:web-search': () => ({ results: [], method: 'error', error: 'not implemented' }),

    // ---- projects (deferred: see plan Phase 4) ----
    'project:resolveChat': () => null,
    'project:appendChat': async () => {},
    'project:loadChat': () => null,
    'project:rebindChat': async () => {},
  }
}

export class MarkdownEditorProvider implements vscode.CustomEditorProvider<MarkdownDocument> {
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<MarkdownDocument>
  >()
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event

  private readonly editors = new Map<vscode.WebviewPanel, MarkdownEditor>()
  private disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly aiSettings: AiSettingsStore,
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<MarkdownDocument> {
    return new MarkdownDocument(uri)
  }

  async resolveCustomEditor(
    document: MarkdownDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const editor = new MarkdownEditor(document, panel, this.context, this.aiSettings, () => {
      this._onDidChangeCustomDocument.fire({ document })
    })

    this.editors.set(panel, editor)

    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown')] }
    panel.webview.html = await this.getHtml(panel.webview)
    panel.webview.onDidReceiveMessage((msg) => editor.handle(msg))

    this.disposables.push(
      panel.onDidDispose(() => {
        this.editors.delete(panel)
        editor.dispose()
      }),
      vscode.window.onDidChangeActiveColorTheme(() => editor.broadcastTheme(currentTheme())),
    )
  }

  async saveCustomDocument(
    document: MarkdownDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const editor = this.findByDocument(document)
    editor?.broadcastSaveRequest('save')
    await editor?.waitForSave(1500)
  }

  async saveCustomDocumentAs(
    document: MarkdownDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const editor = this.findByDocument(document)
    if (!editor) return
    editor.setSaveAsTarget(destination)
    editor.broadcastSaveRequest('saveAs')
    await editor.waitForSave(3000)
  }

  async revertCustomDocument(
    document: MarkdownDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    // Reload the webview; the renderer re-reads the file on mount.
    const editor = this.findByDocument(document)
    if (editor) editor.panel.webview.html = await this.getHtml(editor.panel.webview)
  }

  async backupCustomDocument(
    document: MarkdownDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const backupUri = vscode.Uri.joinPath(context.destination, 'document.md')
    await vscode.workspace.fs.copy(document.uri, backupUri, { overwrite: true })
    return {
      id: backupUri.toString(),
      delete: async () => {
        await vscode.workspace.fs.delete(backupUri).then(undefined, () => {})
      },
    }
  }

  private findByDocument(document: MarkdownDocument): MarkdownEditor | undefined {
    for (const editor of this.editors.values()) {
      if (editor.document === document) return editor
    }
    return undefined
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'markdown')
    const indexPath = vscode.Uri.joinPath(mediaDir, 'index.html')
    const html = await readFileBytes(indexPath)
      .then((b) => Buffer.from(b).toString('utf8'))
      .catch(() => null)
    if (!html) {
      return `<!doctype html><html><body style="padding:2rem;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <h2>GenOffice Markdown editor is not built.</h2>
        <p>Run <code>npm run build:vscode</code> in the repo root and reload this editor.</p>
      </body></html>`
    }
    const cleaned = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
    const base = webview.asWebviewUri(mediaDir).toString().replace(/\/$/, '') + '/'
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob: https: http:`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} https: http:`,
      `worker-src ${webview.cspSource} blob:`,
    ].join('; ')
    return cleaned
      .replace(/<head>/i, `<head>\n    <base href="${base}">`)
      .replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this._onDidChangeCustomDocument.dispose()
  }
}

export function registerMarkdownEditor(
  context: vscode.ExtensionContext,
  aiSettings: AiSettingsStore,
): vscode.Disposable {
  const provider = new MarkdownEditorProvider(context, aiSettings)
  return vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  })
}
