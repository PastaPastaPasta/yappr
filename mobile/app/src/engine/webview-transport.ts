import { createHandlerSet, type Transport } from '@engine/rpc/transport';

/** The part of a react-native-webview ref the transport needs. */
export interface InjectableWebView {
  injectJavaScript(script: string): void;
}

export interface WebViewTransport extends Transport {
  /** The WebView's ref callback. Messages sent before it attaches are held. */
  attach(view: InjectableWebView | null): void;
  /** Feed `onMessage` data in. */
  receive(message: string): void;
  /** Run a host script in the page (dev diagnostics only; never with data). */
  evaluate(script: string): void;
}

/**
 * The host side of the react-native-webview bridge, one per engine epoch.
 * Outgoing messages are delivered with `injectJavaScript` as a JSON string
 * literal passed to `window.__yapprEngineReceive` (mobile/engine
 * src/rpc/transport.ts); the message is data, never code. Before the engine
 * has loaded, the receiver does not exist yet and the message is dropped,
 * which is fine: the only such message is the client's ping, and the engine
 * says hello by itself once it loads.
 */
export function createWebViewTransport(): WebViewTransport {
  const handlers = createHandlerSet();
  let view: InjectableWebView | null = null;
  let held: string[] = [];

  const inject = (target: InjectableWebView, message: string) => {
    target.injectJavaScript(
      `window.__yapprEngineReceive && window.__yapprEngineReceive(${JSON.stringify(message)}); true;`,
    );
  };

  return {
    send(message) {
      if (view) inject(view, message);
      else held.push(message);
    },
    onMessage: handlers.onMessage,
    attach(next) {
      view = next;
      if (!next) return;
      const backlog = held;
      held = [];
      for (const message of backlog) inject(next, message);
    },
    receive: handlers.deliver,
    evaluate(script) {
      view?.injectJavaScript(script);
    },
  };
}
