#!/usr/bin/env node
// Test-wallet responder for dash-key: and dash-st: (ADR-001 E5.4). Builds the
// bundle, then runs it. See README.md; `npm --prefix mobile/tools ci` first.
import { pathToFileURL } from 'node:url'
import { build } from './build.mjs'

const { main } = await import(pathToFileURL(await build()).href)
// Exit explicitly: the SDK may keep handles open after the answer.
process.exit(await main(process.argv.slice(2)))
