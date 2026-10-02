/**
 * The Node stand-in for src/wasm-source.ts: the SDK's WASM straight from the
 * package (the bundle's engine.wasm.js is built from the same file).
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { setWasmSource } from '../../src/shims/wasm-sdk'

const wasmPath = createRequire(import.meta.url).resolve('@dashevo/wasm-sdk/raw/wasm_sdk_bg.wasm')

setWasmSource(() => readFile(wasmPath))
