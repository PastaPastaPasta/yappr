/**
 * A bidirectional string channel. The dispatcher and the client only ever see
 * this, so the same code runs over the WebView bridge, in-process in Node, or
 * in a Playwright page.
 */
export interface Transport {
  send(message: string): void
  /** Registers a receiver; returns its unsubscribe. */
  onMessage(handler: (message: string) => void): () => void
}

/** A transport whose receivers are a simple fan-out list; `deliver` feeds them. */
export function createHandlerSet() {
  const handlers = new Set<(message: string) => void>()
  return {
    onMessage(handler: (message: string) => void) {
      handlers.add(handler)
      return () => { handlers.delete(handler) }
    },
    deliver(message: string) {
      for (const handler of handlers) handler(message)
    },
  }
}

/**
 * Two connected in-process endpoints. Delivery is asynchronous (a microtask),
 * like the real bridge, so tests cannot accidentally depend on synchronous
 * replies.
 */
export function createInProcessPair(): [Transport, Transport] {
  const a = createHandlerSet()
  const b = createHandlerSet()
  const asyncDeliver = (target: ReturnType<typeof createHandlerSet>) => (message: string) => {
    queueMicrotask(() => target.deliver(message))
  }
  return [
    { send: asyncDeliver(b), onMessage: a.onMessage },
    { send: asyncDeliver(a), onMessage: b.onMessage },
  ]
}

interface ReactNativeWebViewBridge {
  postMessage(message: string): void
}

declare global {
  interface Window {
    ReactNativeWebView?: ReactNativeWebViewBridge
    /** The host calls this through `injectJavaScript` to deliver a message to the engine. */
    __yapprEngineReceive?: (message: string) => void
  }
}

/**
 * The engine side of the react-native-webview bridge: outgoing messages go to
 * `window.ReactNativeWebView.postMessage`, incoming ones arrive through
 * `window.__yapprEngineReceive(json)`.
 */
export function createWebViewTransport(target: Window = window): Transport {
  const handlers = createHandlerSet()
  target.__yapprEngineReceive = handlers.deliver
  return {
    send(message) {
      const bridge = target.ReactNativeWebView
      if (!bridge) throw new Error('ReactNativeWebView bridge is not available')
      bridge.postMessage(message)
    },
    onMessage: handlers.onMessage,
  }
}
