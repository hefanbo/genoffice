import * as vscode from 'vscode'

export type UiTheme = 'light' | 'dark' | 'system'

/**
 * Map VSCode's resolved colour theme to an explicit light/dark value so the
 * webview's `data-theme` always matches VSCode (the `prefers-color-scheme`
 * fallback in the tokens would otherwise follow the OS, not VSCode's theme).
 */
export function currentTheme(): 'light' | 'dark' {
  const kind = vscode.window.activeColorTheme.kind
  return kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight
    ? 'light'
    : 'dark'
}
