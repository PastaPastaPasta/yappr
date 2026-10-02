// The glue module both of wasm-sdk's entries share (src/shims/wasm-sdk.ts imports it
// directly). The package types it only under `./raw`, its sibling with the same API.
declare module '@dashevo/wasm-sdk/raw/wasm_sdk.no_url.js' {
  export * from '@dashevo/wasm-sdk/raw'
  export { default } from '@dashevo/wasm-sdk/raw'
}
