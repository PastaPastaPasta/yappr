// @ts-check
/**
 * Babel plugin: named imports from react-native-heroicons' barrels become
 * imports of the one icon file each (D-L3a-011):
 *
 *   import { HeartIcon, BellIcon as Bell } from 'react-native-heroicons/outline';
 *   // becomes
 *   import HeartIcon from 'react-native-heroicons/outline/HeartIcon';
 *   import Bell from 'react-native-heroicons/outline/BellIcon';
 *
 * Each barrel `require`s all of its ~300 icons at the top level, and Metro
 * does not tree-shake, so importing one icon put every outline and solid icon
 * (about 590 modules, 2.4 MB of source) into the bundle and evaluated them
 * all at startup, each with its own copy of esbuild's interop helpers. The
 * app uses under 100. Source keeps the barrel imports (and their types);
 * only the build changes. Anything other than plain named imports of
 * `…Icon` names is left alone.
 */
const BARREL = /^react-native-heroicons\/(outline|solid|mini|micro)$/;
const ICON_NAME = /^[A-Z][A-Za-z0-9]*Icon$/;

/** @param {{ types: typeof import('@babel/types') }} babel */
module.exports = function directIconImports({ types: t }) {
  return {
    name: 'yappr-direct-icon-imports',
    visitor: {
      /** @param {import('@babel/core').NodePath<import('@babel/types').ImportDeclaration>} path */
      ImportDeclaration(path) {
        const { node } = path;
        const barrel = node.source.value;
        if (!BARREL.test(barrel) || node.importKind === 'type' || node.specifiers.length === 0) return;
        /** @type {{ local: string; icon: string }[]} */
        const icons = [];
        for (const specifier of node.specifiers) {
          if (!t.isImportSpecifier(specifier) || specifier.importKind === 'type') return;
          const icon = t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value;
          if (!ICON_NAME.test(icon)) return;
          icons.push({ local: specifier.local.name, icon });
        }
        path.replaceWithMultiple(
          icons.map(({ local, icon }) =>
            t.importDeclaration([t.importDefaultSpecifier(t.identifier(local))], t.stringLiteral(`${barrel}/${icon}`)),
          ),
        );
      },
    },
  };
};
