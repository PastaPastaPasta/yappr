/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import boundaries from '../../eslint/import-boundaries';
import eslintConfig from '../../eslint.config';

/**
 * The engine modules the app imports at run time (ENGINE_RUNTIME_ALLOWLIST)
 * are bundled into the app by Metro. They must stay dependency-free: they may
 * import only each other, so nothing from lib/, the SDK or any package can
 * reach the React Native bundle through them.
 */
const ENGINE_SRC: string = boundaries.ENGINE_SRC;
const allowlist = (eslintConfig as unknown as { ENGINE_RUNTIME_ALLOWLIST: string[] }).ENGINE_RUNTIME_ALLOWLIST;

const rel = (file: string) => path.relative(ENGINE_SRC, file).split(path.sep).join('/');
const isAllowed = (file: string): boolean => boundaries.isEngineRuntimePath(allowlist, file);

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const runtimeFiles = walk(ENGINE_SRC).filter((file) => file.endsWith('.ts') && isAllowed(file));

/** Every module specifier in a file: static and type imports, re-exports, `import()` and `require()`. */
function specifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.push(match[1]);
  return found;
}

describe('engine runtime imports', () => {
  it('covers the client, transport and protocol modules', () => {
    expect(runtimeFiles.map(rel).sort()).toEqual(
      expect.arrayContaining(['protocol/codec.ts', 'protocol/envelope.ts', 'rpc/client.ts', 'rpc/transport.ts']),
    );
  });

  it.each(runtimeFiles.map((file) => [rel(file), file]))('%s imports only allow-listed engine modules', (_name, file) => {
    for (const spec of specifiers(fs.readFileSync(file, 'utf8'))) {
      expect(spec.startsWith('./') || spec.startsWith('../')).toBe(true);
      const target = path.resolve(path.dirname(file), spec);
      expect({ spec, allowed: isAllowed(`${target}.ts`) || isAllowed(target) }).toEqual({ spec, allowed: true });
    }
  });

  it('finds imports in every form', () => {
    expect(
      specifiers(
        "import { a } from './a'\nimport type { B } from '../b'\nexport * from './c'\nimport './d'\nconst e = require('e')\nawait import('f')",
      ),
    ).toEqual(['./a', '../b', './c', './d', 'e', 'f']);
  });
});
