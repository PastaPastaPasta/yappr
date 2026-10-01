/**
 * The app's import boundaries (ADR-001 E1/E2), enforced on resolved paths so
 * `..` tricks (`~/../../lib`, `.././../lib`, `@/lib/types/../constants`) and
 * every import form (static, re-export, dynamic `import()`, `require`,
 * `jest.requireActual`, TS `import x = require()` and `import('x')` types)
 * get the same answer:
 *
 * - `@dashevo/*` is never imported. The engine owns the SDK.
 * - Everything must resolve inside mobile/app, except:
 *   - `mobile/engine/src` (alias `@engine/*`), for types only, plus runtime
 *     imports of the dependency-free wire modules on the engine runtime
 *     allowlist (the protocol, codec and RPC client the host shares with the
 *     engine; src/__tests__/engine-runtime-imports.test.ts keeps them pure);
 *   - web `lib/` modules on the allowlist, and only from the allowlist file.
 * - Module specifiers must be string literals, so they can be checked.
 */
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '../..');
const ENGINE_SRC = path.resolve(APP_ROOT, '../engine/src');

/**
 * Whether `resolved` (an absolute path) is one of the engine modules on
 * `allowlist`: `protocol/` allows a directory, `rpc/client` one module
 * (with or without `.ts`).
 * @param {string[]} allowlist
 * @param {string} resolved
 */
function isEngineRuntimePath(allowlist, resolved) {
  const rel = path.relative(ENGINE_SRC, resolved).split(path.sep).join('/').replace(/\.ts$/, '');
  return allowlist.some((entry) => (entry.endsWith('/') ? rel.startsWith(entry) : rel === entry));
}

/** Mirrors tsconfig.json `paths`. */
const ALIASES = [
  ['~/', path.join(APP_ROOT, 'src')],
  ['@assets/', path.join(APP_ROOT, 'assets')],
  ['@engine/', ENGINE_SRC],
  ['@/', REPO_ROOT],
];

const isInside = (/** @type {string} */ file, /** @type {string} */ dir) => {
  const rel = path.relative(dir, file);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * @param {string} specifier
 * @param {string} fromFile
 * @returns {string | undefined} the absolute path, or undefined for a package
 */
function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    return path.resolve(path.dirname(fromFile), specifier);
  }
  for (const [prefix, target] of ALIASES) {
    if (specifier.startsWith(prefix)) return path.join(target, specifier.slice(prefix.length));
  }
  if (path.isAbsolute(specifier)) return specifier;
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    schema: [
      {
        type: 'object',
        properties: {
          libAllowlist: { type: 'array', items: { type: 'string' } },
          libTypeAllowlist: { type: 'array', items: { type: 'string' } },
          allowlistFile: { type: 'string' },
          engineRuntimeAllowlist: { type: 'array', items: { type: 'string' } },
          allowRepoFiles: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      sdk: "'{{spec}}': the app never touches the Dash SDK. Go through the engine (~/engine), ADR-001 E1.",
      outside:
        "'{{spec}}' resolves outside mobile/app. Use ~/ (or @assets/) for app modules; web lib/ modules come through ~/lib-allowlist.",
      libDirect: "'{{spec}}': import web lib/ modules from ~/lib-allowlist, not directly.",
      libNotAllowed: "'{{spec}}' ({{repoPath}}) is not on LIB_ALLOWLIST in eslint.config.js (ADR-001 E2).",
      libTypeOnly: "'{{spec}}' is allow-listed for types only. Use `import type` / `export type`.",
      engineTypeOnly:
        "'{{spec}}': only types come from the engine package, apart from the wire modules on ENGINE_RUNTIME_ALLOWLIST (eslint.config.js). Call the engine through ~/engine.",
      computed: 'Module specifiers must be string literals so the import boundaries can be checked.',
    },
  },
  create(context) {
    const options = context.options[0] ?? {};
    const libAllowlist = new Set(options.libAllowlist ?? []);
    const libTypeAllowlist = new Set(options.libTypeAllowlist ?? []);
    const allowlistFile = path.resolve(APP_ROOT, options.allowlistFile ?? 'src/lib-allowlist.ts');
    const engineRuntime = options.engineRuntimeAllowlist ?? [];
    const filename = context.filename;

    /**
     * @param {import('estree').Node} node
     * @param {string} spec
     * @param {boolean} typeOnly
     */
    function check(node, spec, typeOnly) {
      if (spec === '@dashevo' || spec.startsWith('@dashevo/')) {
        context.report({ node, messageId: 'sdk', data: { spec } });
        return;
      }
      const resolved = resolveSpecifier(spec, filename);
      if (resolved === undefined || isInside(resolved, APP_ROOT)) return;

      if (isInside(resolved, ENGINE_SRC)) {
        if (!typeOnly && !isEngineRuntimePath(engineRuntime, resolved)) {
          context.report({ node, messageId: 'engineTypeOnly', data: { spec } });
        }
        return;
      }
      if (options.allowRepoFiles && isInside(resolved, REPO_ROOT)) return;

      const repoPath = path.relative(REPO_ROOT, resolved).split(path.sep).join('/');
      if (!isInside(resolved, REPO_ROOT) || !(repoPath === 'lib' || repoPath.startsWith('lib/'))) {
        context.report({ node, messageId: 'outside', data: { spec } });
      } else if (filename !== allowlistFile) {
        context.report({ node, messageId: 'libDirect', data: { spec } });
      } else if (libAllowlist.has(repoPath)) {
        // Allowed for values and types.
      } else if (libTypeAllowlist.has(repoPath)) {
        if (!typeOnly) context.report({ node, messageId: 'libTypeOnly', data: { spec } });
      } else {
        context.report({ node, messageId: 'libNotAllowed', data: { spec, repoPath } });
      }
    }

    /**
     * @param {any} source
     * @param {boolean} typeOnly
     */
    function checkSource(source, typeOnly) {
      if (source && source.type === 'Literal' && typeof source.value === 'string') {
        check(source, source.value, typeOnly);
      } else if (source && source.type === 'TemplateLiteral' && source.expressions.length === 0) {
        check(source, source.quasis[0].value.cooked, typeOnly);
      } else if (source) {
        context.report({ node: source, messageId: 'computed' });
      }
    }

    const allType = (/** @type {any[]} */ specifiers, /** @type {string} */ key) =>
      specifiers.length > 0 && specifiers.every((s) => s[key] === 'type');

    /**
     * `require(x)`, `require.resolve(x)`, `require.resolveWeak(x)`, `require.context(dir)`
     * (Metro bundles the whole directory), `jest.requireActual(x)`, `jest.mock(x)`, ...
     */
    const isModuleCall = (/** @type {any} */ callee) =>
      (callee.type === 'Identifier' && callee.name === 'require') ||
      (callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        ((callee.object.name === 'require' &&
          ['resolve', 'resolveWeak', 'context'].includes(callee.property.name)) ||
          (callee.object.name === 'jest' &&
            ['requireActual', 'requireMock', 'mock', 'doMock', 'unmock', 'createMockFromModule'].includes(
              callee.property.name,
            ))));

    return {
      /** @param {any} node */
      ImportDeclaration(node) {
        checkSource(node.source, node.importKind === 'type' || allType(node.specifiers, 'importKind'));
      },
      /** @param {any} node */
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkSource(node.source, node.exportKind === 'type' || allType(node.specifiers, 'exportKind'));
        }
      },
      /** @param {any} node */
      ExportAllDeclaration(node) {
        checkSource(node.source, node.exportKind === 'type');
      },
      /** @param {any} node */
      ImportExpression(node) {
        checkSource(node.source, false);
      },
      /** @param {any} node */
      CallExpression(node) {
        if (isModuleCall(node.callee)) checkSource(node.arguments[0], false);
      },
      /** @param {any} node */
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference.type === 'TSExternalModuleReference') {
          checkSource(node.moduleReference.expression, node.importKind === 'type');
        }
      },
      /** `typeof import('x')` in a type position. */
      /** @param {any} node */
      TSImportType(node) {
        // typescript-eslint is moving the specifier from `argument` (a TSLiteralType) to `source`.
        const source = node.source ?? node.argument?.literal;
        if (source) checkSource(source, true);
        else context.report({ node, messageId: 'computed' });
      },
    };
  },
};

module.exports = { rules: { 'import-boundaries': rule }, APP_ROOT, ENGINE_SRC, isEngineRuntimePath };
