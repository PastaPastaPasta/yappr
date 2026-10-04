import { transformSync } from '@babel/core';
import fs from 'fs';
import path from 'path';

// Tooling: the Babel config Metro and Jest load, and the plugin it runs on every app module.
import babelConfig from '../../babel.config.js';
import directIconImports from '../../plugins/babel-direct-icon-imports';

const APP_DIR = path.resolve(__dirname, '../..');
const SRC_DIR = path.join(APP_DIR, 'src');

const transform = (code: string) =>
  transformSync(code, { babelrc: false, configFile: false, plugins: [directIconImports], filename: 'x.js' })?.code;

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  });
}

describe('direct heroicon imports (D-L3a-011)', () => {
  it('imports each named icon from its own file, keeping local names', () => {
    expect(transform("import { HeartIcon, BellIcon as Bell } from 'react-native-heroicons/outline';")).toBe(
      'import HeartIcon from "react-native-heroicons/outline/HeartIcon";\nimport Bell from "react-native-heroicons/outline/BellIcon";',
    );
    expect(transform("import { HeartIcon as HeartSolid } from 'react-native-heroicons/solid';")).toBe(
      'import HeartSolid from "react-native-heroicons/solid/HeartIcon";',
    );
  });

  it('leaves every other import alone', () => {
    for (const code of [
      "import * as Outline from 'react-native-heroicons/outline';",
      "import Outline, { HeartIcon } from 'react-native-heroicons/outline';",
      "import { iconNames } from 'react-native-heroicons/outline';",
      "import 'react-native-heroicons/outline';",
      "import { HeartIcon } from 'some-other-icons';",
    ]) {
      expect(transform(code)).toBe(code);
    }
  });

  it('is what babel.config.js runs', () => {
    expect(babelConfig({ cache: () => undefined }).plugins).toContain('./plugins/babel-direct-icon-imports');
  });

  it('points every icon the app imports at a file the package ships', () => {
    const barrelImport = /import\s*\{([^}]*)\}\s*from\s*'react-native-heroicons\/(outline|solid)'/g;
    const icons = new Set<string>();
    for (const file of sourceFiles(SRC_DIR)) {
      for (const [, names, style] of fs.readFileSync(file, 'utf8').matchAll(barrelImport)) {
        for (const name of names.split(',')) {
          const icon = name.trim().split(/\s+as\s+/)[0];
          if (icon) icons.add(`${style}/${icon}`);
        }
      }
    }
    expect(icons.size).toBeGreaterThan(20);
    // A small fraction of the ~590 icons the barrels would pull in.
    expect(icons.size).toBeLessThan(150);
    const missing = [...icons].filter(
      (icon) => !fs.existsSync(path.join(APP_DIR, 'node_modules/react-native-heroicons', `${icon}.js`)),
    );
    expect(missing).toEqual([]);
  });
});
