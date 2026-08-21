import { isBridgeMessage, tag } from './protocol'

declare global {
  // `globalThis` (not `window`) so this webview-side module typechecks in both
  // the DOM lib (apps/docs) and the DOM-less Node host (apps/vscode-ext).
  var acquireVsCodeApi: (() => {
    postMessage(message: unknown): void
    getState(): unknown
    setState(state: unknown): void
  }) | undefined
}

/** A minimal request/response + event-subscription bridge over `postMessage`. */
export interface Rpc {
  /** request/response (mirrors Electron's `ipcRenderer.invoke`) */
  invoke(method: string, ...args: unknown[]): Promise<unknown>
  /** event subscription (mirrors `ipcRenderer.on`); returns an unsubscribe fn */
  on(event: string, handler: (...args: any[]) => void): () => void
  /** fire-and-forget (mirrors `ipcRenderer.send`) */
  send(method: string, ...args: unknown[]): void
}

export function hasVsCodeApi(): boolean {
  return typeof globalThis.acquireVsCodeApi === 'function'
}

export function createRpc(): Rpc {
  const vs = globalThis.acquireVsCodeApi
  if (typeof vs !== 'function') {
    throw new Error('acquireVsCodeApi is unavailable in this context')
  }
  const api = vs()
  let seq = 0
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const handlers = new Map<string, Set<(...args: any[]) => void>>()

  // `addEventListener` isn't on the DOM-less `typeof globalThis` (Node host
  // typecheck); cast a minimal listener shape — the webview's real DOM listener
  // has the same contract.
  const g = globalThis as typeof globalThis & {
    addEventListener?: (type: 'message', listener: (event: { data: unknown }) => void) => void
  }
  g.addEventListener?.('message', (event) => {
    const msg = event.data
    if (!isBridgeMessage(msg)) return
    if (msg.kind === 'response') {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.ok) p.resolve(msg.value)
      else p.reject(new Error(msg.error))
    } else if (msg.kind === 'event') {
      const set = handlers.get(msg.event)
      if (set) for (const fn of [...set]) fn(...msg.args)
    }
  })

  return {
    invoke(method, ...args) {
      return new Promise((resolve, reject) => {
        const id = ++seq
        pending.set(id, { resolve, reject })
        api.postMessage(tag({ kind: 'request', id, method, args }))
      })
    },
    on(event, handler) {
      let set = handlers.get(event)
      if (!set) {
        set = new Set()
        handlers.set(event, set)
      }
      set.add(handler)
      api.postMessage(tag({ kind: 'subscribe', event }))
      let active = true
      return () => {
        if (!active) return
        active = false
        set!.delete(handler)
        api.postMessage(tag({ kind: 'unsubscribe', event }))
      }
    },
    send(method, ...args) {
      api.postMessage(tag({ kind: 'send', method, args }))
    },
  }
}

// ---- binary helpers (webview side: btoa/atob are native) ----

export function bytesToBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const u8 = base64ToBytes(b64)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}
