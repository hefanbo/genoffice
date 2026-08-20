import { isBridgeMessage, tag } from './protocol'

/** Channel name (e.g. `docs:save`, `app:get-theme`) → implementation. */
export type BridgeHandler = Record<string, (...args: any[]) => unknown>

export interface BridgeHost {
  /** Dispatch an inbound message from the webview. */
  handle(raw: unknown): void
  /** Push an event to the webview (only when it subscribed). */
  broadcast(event: string, ...args: unknown[]): void
}

/**
 * Host-side counterpart of `createRpc()`. `post` forwards a message to the
 * webview (typically `panel.webview.postMessage`).
 */
export function createBridgeHost(
  post: (message: unknown) => void,
  handler: BridgeHandler,
): BridgeHost {
  const subscribed = new Set<string>()

  function respond(id: number, value: unknown): void {
    post(tag({ kind: 'response', id, ok: true, value }))
  }
  function fail(id: number, error: string): void {
    post(tag({ kind: 'response', id, ok: false, error }))
  }

  return {
    handle(raw: unknown) {
      if (!isBridgeMessage(raw)) return
      const msg = raw
      switch (msg.kind) {
        case 'subscribe':
          subscribed.add(msg.event)
          return
        case 'unsubscribe':
          subscribed.delete(msg.event)
          return
        case 'send': {
          const fn = handler[msg.method]
          if (typeof fn === 'function') {
            Promise.resolve()
              .then(() => fn(...msg.args))
              .catch(() => {})
          }
          return
        }
        case 'request': {
          const fn = handler[msg.method]
          if (typeof fn !== 'function') {
            fail(msg.id, `Unknown method: ${msg.method}`)
            return
          }
          Promise.resolve()
            .then(() => fn(...msg.args))
            .then((value) => respond(msg.id, value))
            .catch((err) => fail(msg.id, err?.message ?? String(err)))
          return
        }
        default:
          return
      }
    },
    broadcast(event, ...args) {
      if (!subscribed.has(event)) return
      post(tag({ kind: 'event', event, args }))
    },
  }
}
