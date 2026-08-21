import * as vscode from 'vscode'
import { createBridgeHost, type BridgeHandler } from '@genoffice/vscode-bridge'
import { configureMetricsCache, familyVerticalMetrics } from '@genoffice/font-metrics'
import {
  basenameOf,
  base64ToBytes,
  bytesToBase64,
  mapVscodeLanguage,
  readFileBytes,
  sha256Hex,
  writeFileBytes,
} from '../services/util'
import { currentTheme } from '../services/theme'
import { AiSettingsStore } from '../services/ai-settings'
import {
  commitDocPasswordSave,
  currentDocPasswordIntentRevision,
  discardDocPasswordIntents,
  docPasswordFor,
  DocxDecryptError,
  decryptDocx,
  encryptDocx,
  isEncryptedDocx,
  rememberDocPassword,
  setDocPassword,
  snapshotDocPassword,
} from '../../../docs/src/main/docx-encryption'

const VIEW_TYPE = 'genoffice.docx'

interface OpenFileResult {
  path: string
  name: string
  data: string // base64
  hash: string
  encrypted?: boolean
}

/** mirrors apps/docs OpenDocxResult: encrypted files come back asking for a password */
type OpenDocxResult = OpenFileResult | { needsPassword: true; path: string; name: string } | null

/** unique per-editor id keying docx-encryption's in-memory password store (mirrors Electron's wcId) */
let nextDocxWcId = 1

class DocsDocument implements vscode.CustomDocument {
  readonly uri: vscode.Uri
  constructor(uri: vscode.Uri) {
    this.uri = uri
  }
  dispose() {}
}

/** One open docs editor: its webview, its bridge, and its per-editor state. */
class DocsEditor {
  readonly bridge: ReturnType<typeof createBridgeHost>
  readonly panel: vscode.WebviewPanel
  readonly document: DocsDocument
  /** keys docx-encryption's per-editor password state (Electron's webContents id) */
  readonly wcId = nextDocxWcId++

  private initialResult: OpenDocxResult = null
  private initialConsumed = false
  private saveWaiters: Array<() => void> = []
  private pendingSaveAsTarget: vscode.Uri | null = null
  private lastSavedBytes: Uint8Array | null = null

  constructor(
    document: DocsDocument,
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext,
    aiSettings: AiSettingsStore,
    private onDidEdit: () => void,
  ) {
    this.document = document
    this.panel = panel
    this.bridge = createBridgeHost((msg) => panel.webview.postMessage(msg), buildHandlers(this, context, aiSettings))
  }

  async init(): Promise<void> {
    const bytes = await readFileBytes(this.document.uri)
    this.lastSavedBytes = bytes // on-disk bytes; backups stay as encrypted as the file
    const path = this.document.uri.fsPath
    const name = basenameOf(path)
    const buffer = Buffer.from(bytes)
    if (isEncryptedDocx(buffer)) {
      const pwd = docPasswordFor(this.wcId, path)
      if (!pwd) {
        this.initialResult = { needsPassword: true, path, name }
        return
      }
      const plain = await decryptDocx(buffer, pwd)
      const plainBytes = new Uint8Array(plain)
      this.initialResult = {
        path,
        name,
        data: bytesToBase64(plainBytes),
        hash: sha256Hex(plain),
        encrypted: true,
      }
      return
    }
    this.initialResult = { path, name, data: bytesToBase64(bytes), hash: sha256Hex(bytes) }
  }

  consumeInitial(): OpenDocxResult {
    if (this.initialConsumed) return null
    this.initialConsumed = true
    return this.initialResult
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

  markSaved(bytes: Uint8Array): void {
    this.lastSavedBytes = bytes
    this.signalSaved()
  }

  get lastSaved(): Uint8Array | null {
    return this.lastSavedBytes
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

  private signalSaved(): void {
    const waiters = this.saveWaiters.splice(0)
    for (const w of waiters) w()
  }

  handle(raw: unknown): void {
    this.bridge.handle(raw)
  }

  broadcastCommand(command: string, payload?: string): void {
    this.bridge.broadcast('menu:command', command, payload)
  }

  broadcastTheme(theme: 'light' | 'dark'): void {
    this.bridge.broadcast('app:theme-changed', theme)
  }

  dispose(): void {
    this.bridge.broadcast('docs:teardown')
  }
}

async function loadPath(fsPath: string, wcId: number): Promise<OpenDocxResult> {
  try {
    if (!/\.docx$/i.test(fsPath)) return null
    const bytes = await readFileBytes(vscode.Uri.file(fsPath))
    const name = basenameOf(fsPath)
    const buffer = Buffer.from(bytes)
    if (isEncryptedDocx(buffer)) {
      // a remembered disk password (same editor reopens, e.g. revert) decrypts
      // silently; otherwise the renderer shows the password prompt
      const pwd = docPasswordFor(wcId, fsPath)
      if (!pwd) return { needsPassword: true, path: fsPath, name }
      const plain = await decryptDocx(buffer, pwd)
      const plainBytes = new Uint8Array(plain)
      return {
        path: fsPath,
        name,
        data: bytesToBase64(plainBytes),
        hash: sha256Hex(plain),
        encrypted: true,
      }
    }
    return { path: fsPath, name, data: bytesToBase64(bytes), hash: sha256Hex(bytes) }
  } catch {
    return null
  }
}

function buildHandlers(
  editor: DocsEditor,
  context: vscode.ExtensionContext,
  aiSettings: AiSettingsStore,
): BridgeHandler {
  const writeDocx = async (
    filePath: string,
    dataBase64: string,
    snapshotKey: string | null,
  ): Promise<{ ok: boolean; path?: string; error?: string; passwordIntentPending?: boolean }> => {
    try {
      const buffer = Buffer.from(base64ToBytes(dataBase64))
      // effective password for this save: a desired intent wins, else the disk
      // password when the file is encrypted (mirrors snapshotDocPassword in
      // docs-main); null = keep the file plain
      const passwordState = snapshotDocPassword(editor.wcId, snapshotKey)
      const outBytes = passwordState.password ? encryptDocx(buffer, passwordState.password) : buffer
      const out = new Uint8Array(outBytes)
      await writeFileBytes(vscode.Uri.file(filePath), out)
      const passwordIntentPending = commitDocPasswordSave(editor.wcId, passwordState, filePath)
      editor.markSaved(out)
      return { ok: true, passwordIntentPending }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    // ---- language / theme ----
    'app:get-language': () => mapVscodeLanguage(vscode.env.language),
    'app:get-theme': () => currentTheme(),

    // ---- open ----
    'docs:consume-pending-open': () => editor.consumeInitial(),
    'docs:consume-new-blank': () => false,
    'docs:open': async () => {
      const picked = await vscode.window.showOpenDialog({
        filters: { 'Word document': ['docx'] },
        canSelectMany: false,
      })
      if (!picked || picked.length === 0) return null
      return loadPath(picked[0].fsPath, editor.wcId)
    },
    'docs:open-path': (filePath: string) => loadPath(filePath, editor.wcId),

    // ---- password protection (docx encryption) — ported from the Electron
    // main process via docx-encryption.ts, keyed by per-editor wcId. ----
    'docs:password-intent-revision': () => currentDocPasswordIntentRevision(),
    'docs:discard-password-intents': (throughRevision: number) => {
      discardDocPasswordIntents(editor.wcId, throughRevision)
      return { ok: true }
    },
    'docs:set-password': (filePath: string | null, password: string | null) => {
      setDocPassword(editor.wcId, filePath, password)
      return { ok: true }
    },
    'docs:open-decrypt': async (path: string, password: string) => {
      try {
        const bytes = await readFileBytes(vscode.Uri.file(path))
        const buffer = Buffer.from(bytes)
        if (!isEncryptedDocx(buffer)) return { ok: false, reason: 'error', error: 'not encrypted' }
        const plain = await decryptDocx(buffer, password)
        const plainBytes = new Uint8Array(plain)
        rememberDocPassword(editor.wcId, path, password)
        return {
          ok: true,
          result: {
            path,
            name: basenameOf(path),
            data: bytesToBase64(plainBytes),
            hash: sha256Hex(plain),
            encrypted: true,
          },
        }
      } catch (err) {
        if (err instanceof DocxDecryptError) return { ok: false, reason: err.reason }
        return { ok: false, reason: 'error', error: String(err) }
      }
    },

    // ---- save ----
    'docs:save': (filePath: string, dataBase64: string, auto?: boolean) =>
      writeDocx(filePath, dataBase64, filePath),
    'docs:write-recovery': () => {
      // 30s-tick fallback dirty signal (the renderer also reports transitions
      // directly via docs:dirty-changed, which lights the indicator immediately).
      editor.markEdited()
      return { ok: true }
    },
    'docs:dirty-changed': (dirty: boolean) => {
      if (dirty) editor.markEdited()
    },
    'docs:save-as': async (defaultName: string, dataBase64: string, sourcePath?: string | null) => {
      let target = editor.getPendingSaveAsTarget()
      if (!target) {
        const picked = await vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(defaultName),
          filters: { 'Word document': ['docx'] },
        })
        if (!picked) return { ok: false }
        target = picked
      }
      // the source document's desired password carries to the new path
      const snapshotKey =
        typeof sourcePath === 'string' && sourcePath ? sourcePath : editor.document.uri.fsPath
      const result = await writeDocx(target.fsPath, dataBase64, snapshotKey)
      editor.setSaveAsTarget(null)
      return result.ok
        ? { ok: true, path: target.fsPath, passwordIntentPending: result.passwordIntentPending }
        : result
    },
    'docs:save-new': async (defaultName: string, dataBase64: string) => {
      const dir = vscode.Uri.joinPath(context.globalStorageUri, 'documents')
      await vscode.workspace.fs.createDirectory(dir)
      const target = vscode.Uri.joinPath(dir, defaultName)
      // snapshot key null → the pathless document's desired password
      const result = await writeDocx(target.fsPath, dataBase64, null)
      return result.ok
        ? { ok: true, path: target.fsPath, passwordIntentPending: result.passwordIntentPending }
        : result
    },

    // ---- recent ----
    'docs:recent': () => (context.globalState.get<string[]>('genoffice.recent', []) || []),

    // ---- images ----
    'docs:pick-image': async () => {
      const picked = await vscode.window.showOpenDialog({
        filters: { Images: ['png', 'jpg', 'jpeg', 'gif'] },
        canSelectMany: false,
      })
      if (!picked || picked.length === 0) return null
      const bytes = await readFileBytes(picked[0])
      const ext = picked[0].fsPath.split('.').pop()?.toLowerCase() ?? 'png'
      const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`
      return { base64: bytesToBase64(bytes), mime, name: basenameOf(picked[0].fsPath) }
    },

    // ---- fonts ----
    'docs:font-metrics': (family: string) =>
      typeof family === 'string' ? familyVerticalMetrics(family) : null,

    // ---- print / export (deferred: see plan Phase 5) ----
    'docs:print': async () => {
      await vscode.window.showInformationMessage('Print is not available yet.')
    },
    'docs:export-pdf': () => ({ ok: false, error: 'export-pdf not implemented' }),
    'docs:print-pdf-buffer': () => ({ ok: false, error: 'print-pdf-buffer not implemented' }),
    'docs:save-merged-pdf': () => ({ ok: false, error: 'save-merged-pdf not implemented' }),

    // ---- AI (deferred: see plan Phase 4) ----
    'ai:get-settings': () => aiSettings.get(),
    'ai:set-settings': (settings: unknown) => aiSettings.set(settings as never),
    'ai:chat': () => ({ ok: false, error: 'ai-chat not implemented' }),
    'ai:stream': async () => {},
    'ai:stream-cancel': async () => {},
    'ai:gsk-status': () => ({ loggedIn: false }),
    'ai:gsk-login': async () => {},
    'ai:web-search': () => ({ results: [], method: 'error', error: 'not implemented' }),
    'ai:image-search': () => ({ images: [], method: 'error', error: 'not implemented' }),
    'ai:fetch-image': () => null,

    // ---- attachments (deferred: see plan Phase 4) ----
    'files:pick': () => null,
    'files:add': () => ({ accepted: [], rejected: [] }),
    'files:add-pasted-image': () => ({ accepted: [], rejected: [] }),
    'files:read': () => ({ ok: false, error: 'not implemented' }),
    'files:read-image': () => ({ ok: false, error: 'not implemented' }),

    // ---- tabs (VSCode handles tabs natively) ----
    'win:new': async () => {},
    'win:list': () => [],
    'win:focus': async () => {},

    // ---- projects (deferred: see plan Phase 4) ----
    'project:resolveChat': () => null,
    'project:appendChat': async () => {},
    'project:loadChat': () => null,
    'project:rebindChat': async () => {},
    'project:list': () => [],
    'project:create': () => null,
    'project:rename': async () => {},
    'project:delete': async () => {},
    'project:moveFile': async () => {},
    'project:timeline': () => [],
  }
}

export class DocsEditorProvider implements vscode.CustomEditorProvider<DocsDocument> {
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<DocsDocument>
  >()
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event

  private readonly editors = new Map<vscode.WebviewPanel, DocsEditor>()
  private active: DocsEditor | null = null
  private disposables: vscode.Disposable[] = []

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly aiSettings: AiSettingsStore,
  ) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    _token: vscode.CancellationToken,
  ): Promise<DocsDocument> {
    return new DocsDocument(uri)
  }

  async resolveCustomEditor(
    document: DocsDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const editor = new DocsEditor(document, panel, this.context, this.aiSettings, () => {
      // no-op undo/redo: the renderer owns its own edit history (ProseMirror);
      // firing the edit event is what marks the tab dirty in VSCode.
      this._onDidChangeCustomDocument.fire({ document, undo: () => {}, redo: () => {} })
    })
    await editor.init()

    this.editors.set(panel, editor)
    this.active = editor

    panel.webview.options = this.webviewOptions()
    panel.webview.html = await this.getHtml(panel.webview)
    panel.webview.onDidReceiveMessage((msg) => editor.handle(msg))

    this.disposables.push(
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) this.active = editor
      }),
      panel.onDidDispose(() => {
        this.editors.delete(panel)
        if (this.active === editor) this.active = null
        editor.dispose()
      }),
      vscode.window.onDidChangeActiveColorTheme(() => {
        editor.broadcastTheme(currentTheme())
      }),
    )
  }

  async saveCustomDocument(
    document: DocsDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const editor = this.findByDocument(document)
    editor?.broadcastCommand('save')
    await editor?.waitForSave(1500)
  }

  async saveCustomDocumentAs(
    document: DocsDocument,
    destination: vscode.Uri,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const editor = this.findByDocument(document)
    if (!editor) return
    editor.setSaveAsTarget(destination)
    editor.broadcastCommand('save-as')
    await editor.waitForSave(3000)
  }

  async revertCustomDocument(
    document: DocsDocument,
    _cancellation: vscode.CancellationToken,
  ): Promise<void> {
    const editor = this.findByDocument(document)
    editor?.broadcastCommand('open-path', document.uri.fsPath)
  }

  async backupCustomDocument(
    document: DocsDocument,
    context: vscode.CustomDocumentBackupContext,
    _cancellation: vscode.CancellationToken,
  ): Promise<vscode.CustomDocumentBackup> {
    const editor = this.findByDocument(document)
    const bytes = editor?.lastSaved ?? (await readFileBytes(document.uri).catch(() => null))
    const backupUri = vscode.Uri.joinPath(context.destination, 'document.docx')
    if (bytes) await vscode.workspace.fs.writeFile(backupUri, bytes)
    return {
      id: backupUri.toString(),
      delete: async () => {
        await vscode.workspace.fs.delete(backupUri).then(undefined, () => {})
      },
    }
  }

  /** Post a menu command to the active editor (used by contributed commands). */
  broadcastCommand(command: string, payload?: string): void {
    this.active?.broadcastCommand(command, payload)
  }

  private findByDocument(document: DocsDocument): DocsEditor | undefined {
    for (const editor of this.editors.values()) {
      if (editor.document === document) return editor
    }
    return undefined
  }

  private webviewOptions(): vscode.WebviewOptions {
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'docs')
    return {
      enableScripts: true,
      localResourceRoots: [mediaDir],
    }
  }

  private async getHtml(webview: vscode.Webview): Promise<string> {
    const mediaDir = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'docs')
    const indexPath = vscode.Uri.joinPath(mediaDir, 'index.html')
    let html = await readFileBytes(indexPath)
      .then((b) => Buffer.from(b).toString('utf8'))
      .catch(() => null)
    if (!html) {
      return `<!doctype html><html><body style="padding:2rem;font-family:var(--vscode-font-family);color:var(--vscode-foreground)">
        <h2>GenOffice Docs editor is not built.</h2>
        <p>Run <code>npm run build:vscode</code> in the repo root and reload this editor.</p>
      </body></html>`
    }
    // Drop the source index.html's own CSP (targeted at Electron/`self`) and
    // replace it with a webview-aware policy below.
    html = html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/gi, '')
    const base = webview.asWebviewUri(mediaDir).toString().replace(/\/$/, '') + '/'
    html = html.replace(/<head>/i, `<head>\n    <base href="${base}">`)
    const csp = [
      `default-src 'none'`,
      `script-src ${webview.cspSource} 'unsafe-inline'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `img-src ${webview.cspSource} data: blob: https: http:`,
      `font-src ${webview.cspSource} data:`,
      `connect-src ${webview.cspSource} https: http:`,
      `worker-src ${webview.cspSource} blob:`,
      `child-src ${webview.cspSource} blob:`,
    ].join('; ')
    html = html.replace(/<head>/i, `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`)
    return html
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables = []
    this._onDidChangeCustomDocument.dispose()
  }
}

export interface DocsEditorApi {
  broadcastCommand(command: string, payload?: string): void
  dispose(): void
}

export function registerDocsEditor(
  context: vscode.ExtensionContext,
  aiSettings: AiSettingsStore,
): DocsEditorApi {
  configureMetricsCache(vscode.Uri.joinPath(context.globalStorageUri, 'font-metrics').fsPath)
  const provider = new DocsEditorProvider(context, aiSettings)
  const registration = vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
    webviewOptions: { retainContextWhenHidden: true },
    supportsMultipleEditorsPerDocument: false,
  })
  return {
    broadcastCommand: (command, payload) => provider.broadcastCommand(command, payload),
    dispose: () => {
      registration.dispose()
      provider.dispose()
    },
  }
}

export { VIEW_TYPE as DOCS_VIEW_TYPE }
