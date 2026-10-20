import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { problems, ratioOf } from './brand-set.mjs'

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

  // Editing public/brand/ without `npm run brand` leaves these stale.
  it('has brand.json and the mobile SVG module regenerated from the current files', () => {
    const { ratio } = JSON.parse(read('brand.json'))
    expect(ratio).toEqual({
      wordmark: ratioOf(read('wordmark.svg')),
      lockup: ratioOf(read('lockup.svg')),
      poweredBy: ratioOf(read('powered-by.svg')),
    })
    const svgs = fs.readFileSync(path.join(ROOT, 'mobile/app/src/ui/brand/svgs.ts'), 'utf8')
    for (const file of ['mark.svg', 'mark-dark.svg', 'lockup.svg', 'lockup-dark.svg', 'powered-by.svg', 'powered-by-dark.svg']) {
      expect(svgs).toContain(JSON.stringify(read(file).trim()))
    }
  })
})
