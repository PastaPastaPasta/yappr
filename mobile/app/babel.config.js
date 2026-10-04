module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'nativewind' }], 'nativewind/babel'],
    // One file per icon instead of every heroicon in the bundle (plugins/babel-direct-icon-imports.js).
    plugins: ['./plugins/babel-direct-icon-imports'],
  };
};
