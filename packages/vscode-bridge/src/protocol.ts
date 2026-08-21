/**
 * Message envelope shared by the webview RPC client and the extension-host
 * bridge. Every message is tagged with `ns` so the client can ignore unrelated
 * `message` events (e.g. VSCode's own) and the host can ignore stray payloads.
 *
 * Messages are plain JSON: binary (ArrayBuffer/Uint8Array) is base64-encoded at
 * the shim/handler boundary, never passed through the envelope directly.
 */

export type BridgeMessage =
  | { ns: 'genoffice'; kind: 'request'; id: number; method: string; args: unknown[] }
  | { ns: 'genoffice'; kind: 'send'; method: string; args: unknown[] }
  | { ns: 'genoffice'; kind: 'subscribe'; event: string }
  | { ns: 'genoffice'; kind: 'unsubscribe'; event: string }
  | { ns: 'genoffice'; kind: 'response'; id: number; ok: true; value: unknown }
  | { ns: 'genoffice'; kind: 'response'; id: number; ok: false; error: string }
  | { ns: 'genoffice'; kind: 'event'; event: string; args: unknown[] }

const NS: 'genoffice' = 'genoffice'

export function tag<T>(msg: T): T & { ns: 'genoffice' } {
  return { ns: NS, ...msg } as T & { ns: 'genoffice' }
}

export function isBridgeMessage(value: unknown): value is BridgeMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { ns?: unknown }).ns === NS &&
    typeof (value as { kind?: unknown }).kind === 'string'
  )
}
