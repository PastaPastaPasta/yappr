/**
 * @jest-environment node
 */
import * as tsParser from '@typescript-eslint/parser';
import { RuleTester } from 'eslint';

import boundaries from '../../eslint/import-boundaries';

const file = (rel: string) => `${boundaries.APP_ROOT}/${rel}`;
const ROUTE = file('src/app/(tabs)/(home)/index.tsx');
const ALLOWLIST_FILE = file('src/lib-allowlist.ts');
const options = [{ libAllowlist: ['lib/pure'], libTypeAllowlist: ['lib/types'], allowlistFile: 'src/lib-allowlist.ts' }];

const tester = new RuleTester({
  languageOptions: { parser: tsParser, ecmaVersion: 'latest', sourceType: 'module' },
});

const invalid = (code: string, messageId: string, filename = ROUTE) => ({
  code,
  filename,
  options,
  errors: [{ messageId }],
});

tester.run('import-boundaries', boundaries.rules['import-boundaries'], {
  valid: [
    { code: "import { Text } from 'react-native';", filename: ROUTE, options },
    { code: "import { Screen } from '~/ui/Screen';", filename: ROUTE, options },
    { code: "import x from '../../../ui/Text';", filename: ROUTE, options },
    { code: "const icon = require('@assets/images/icon.png');", filename: ROUTE, options },
    { code: "const ctx = require.context('~/app');", filename: ROUTE, options },
    { code: "import type { EngineApi } from '@engine/api';", filename: ROUTE, options },
    { code: "import { type EngineApi } from '@engine/api';", filename: ROUTE, options },
    { code: "export type { Post } from '@/lib/types';", filename: ALLOWLIST_FILE, options },
    { code: "export { x } from '@/lib/pure';", filename: ALLOWLIST_FILE, options },
  ],
  invalid: [
    invalid("import { EvoSDK } from '@dashevo/evo-sdk';", 'sdk'),
    invalid("import type { X } from '@dashevo/evo-sdk';", 'sdk'),
    invalid("const sdk = import('@dashevo/evo-sdk');", 'sdk'),
    invalid("const sdk = require('@dashevo/evo-sdk');", 'sdk'),
    invalid("export * from '@dashevo/wasm-sdk';", 'sdk'),
    // Escapes out of mobile/app, however they are spelled.
    invalid("import x from '../../../../../../lib/utils';", 'libDirect'),
    invalid("import x from './../../../../../../../vendor/platform-auth';", 'outside'),
    invalid("import x from '.././../../../../../../package.json';", 'outside'),
    invalid("import x from '~/../../engine/src/api';", 'engineTypeOnly'),
    invalid("import x from '~/../../../vendor/x';", 'outside'),
    invalid("import x from '@assets/../../../lib/pure';", 'libDirect'),
    invalid("import x = require('../../../../../../vendor/x');", 'outside'),
    invalid("type T = typeof import('@/vendor/x');", 'outside'),
    // lib/ only through the allowlist file, and only allow-listed paths.
    invalid("import { x } from '@/lib/pure';", 'libDirect'),
    invalid("export { x } from '@/lib/constants';", 'libNotAllowed', ALLOWLIST_FILE),
    invalid("export { x } from '@/lib/types/../constants';", 'libNotAllowed', ALLOWLIST_FILE),
    invalid("export { Post } from '@/lib/types';", 'libTypeOnly', ALLOWLIST_FILE),
    invalid("export * from '@/lib/types';", 'libTypeOnly', ALLOWLIST_FILE),
    // Engine: types only.
    invalid("import { engine } from '@engine/api';", 'engineTypeOnly'),
    invalid("import '@engine/api';", 'engineTypeOnly'),
    // Metro's require.context bundles a whole directory.
    invalid("const lib = require.context('../../../../../../lib');", 'libDirect'),
    invalid("const lib = require.context('@/lib', true);", 'libDirect'),
    invalid("const m = require.resolveWeak('@/lib/constants');", 'libDirect'),
    invalid("const m = require.resolveWeak('@dashevo/evo-sdk');", 'sdk'),
    // Specifiers that can't be checked.
    invalid('const m = import(name);', 'computed'),
    invalid('const m = require(`@dashevo/${x}`);', 'computed'),
  ],
});
