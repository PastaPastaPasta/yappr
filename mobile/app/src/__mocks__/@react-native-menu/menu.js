// Native menus under Jest (used automatically: jest.config.js roots at src/).
// A View carrying the menu's props, so tests read `actions` and fire
// `pressAction` with `{ nativeEvent: { event: <action id> } }`.
const React = require('react');
const { View } = require('react-native');

const MenuView = React.forwardRef(function MenuView(props, ref) {
  React.useImperativeHandle(ref, () => ({ show: () => undefined }));
  return React.createElement(View, props);
});

module.exports = { MenuView };
