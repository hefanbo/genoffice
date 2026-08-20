import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import * as vscode from 'vscode'

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function basenameOf(p: string): string {
  return basename(p)
}

export async function readFileBytes(uri: vscode.Uri): Promise<Uint8Array> {
  return new Uint8Array(await vscode.workspace.fs.readFile(uri))
}

export async function writeFileBytes(uri: vscode.Uri, bytes: Uint8Array): Promise<void> {
  await vscode.workspace.fs.writeFile(uri, bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

export function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

/** 'zh-cn' → 'zh', etc. — normalise a VSCode language id to the supported set. */
const SUPPORTED_LANGS = new Set(['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'th', 'id', 'ru', 'ar'])

export function mapVscodeLanguage(code: string): string {
  const base = (code || 'en').toLowerCase().split('-')[0]
  return SUPPORTED_LANGS.has(base) ? base : 'en'
}
