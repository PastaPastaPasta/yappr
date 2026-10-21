import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { filesIn, problems, ratioOf, sourceHash } from './brand-set.mjs'

const ROOT = path.resolve(__dirname, '..')
const BRAND = path.join(ROOT, 'public/brand')
const CANDIDATES = path.join(ROOT, 'docs/brand/candidates')
const read = (file) => fs.readFileSync(path.join(BRAND, file), 'utf8')

describe('brand set', () => {
  it('installed in public/brand/ follows the set rules', () => {
    expect(problems(BRAND)).toEqual([])
  })

  it.each(fs.readdirSync(CANDIDATES))('candidate %s can be installed', (style) => {
    expect(problems(path.join(CANDIDATES, style))).toEqual([])
  })

  it('counts the optional 16 px favicon twin in the source hash', () => {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-set-'))
    try {
      for (const file of fs.readdirSync(BRAND)) fs.copyFileSync(path.join(BRAND, file), path.join(copy, file))
      expect(filesIn(copy)).toContain('favicon-16.svg')
      expect(problems(copy)).toEqual([])
      fs.appendFileSync(path.join(copy, 'favicon-16.svg'), '\n')
      expect(sourceHash(copy)).not.toBe(sourceHash(BRAND))
      fs.rmSync(path.join(copy, 'favicon-16.svg'))
      expect(filesIn(copy)).not.toContain('favicon-16.svg')
      expect(problems(copy)).toEqual([])
    } finally {
      fs.rmSync(copy, { recursive: true, force: true })
    }
  })

  // Editing public/brand/ without `npm run brand` leaves these stale.
  it('has every generated file built from the current SVGs', () => {
    const { ratio, source } = JSON.parse(read('brand.json'))
    expect(source).toBe(sourceHash(BRAND))
    expect(ratio).toEqual({
      wordmark: ratioOf(read('wordmark.svg')),
      lockup: ratioOf(read('lockup.svg')),
    })
    const svgs = fs.readFileSync(path.join(ROOT, 'mobile/app/src/ui/brand/svgs.ts'), 'utf8')
    for (const file of ['mark.svg', 'mark-dark.svg', 'lockup.svg', 'lockup-dark.svg']) {
      expect(svgs).toContain(JSON.stringify(read(file).trim()))
    }
  })
})
