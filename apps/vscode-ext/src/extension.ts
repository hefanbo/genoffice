import * as vscode from 'vscode'
import { AiSettingsStore } from './services/ai-settings'
import { registerDocsEditor, type DocsEditorApi } from './providers/docs-provider'
import { registerMarkdownEditor } from './providers/markdown-provider'

export function activate(context: vscode.ExtensionContext): void {
  const aiSettings = new AiSettingsStore(context)
  const docs = registerDocsEditor(context, aiSettings)
  context.subscriptions.push({ dispose: () => docs.dispose() })
  context.subscriptions.push(registerMarkdownEditor(context, aiSettings))

  // Menu commands dispatched to the active docs editor as `menu:command`
  // events; the renderer already implements the full `MenuCommand` switch.
  const command = (id: string, menuCommand: string) =>
    vscode.commands.registerCommand(id, () => docs.broadcastCommand(menuCommand))
  const commandWithPayload = (id: string, menuCommand: string) =>
    vscode.commands.registerCommand(id, (payload?: string) => docs.broadcastCommand(menuCommand, payload))

  context.subscriptions.push(
    command('genoffice.docs.save', 'save'),
    command('genoffice.docs.saveAs', 'save-as'),
    command('genoffice.docs.toggleAi', 'toggle-ai'),
    command('genoffice.docs.wordCount', 'word-count'),
    command('genoffice.docs.find', 'find'),
    command('genoffice.docs.exportPdf', 'export-pdf'),
    commandWithPayload('genoffice.docs.open', 'open-path'),
  )
}

export function deactivate(): void {}
