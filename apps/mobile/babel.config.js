module.exports = function (api) {
  api.cache(true);
  return {
    presets: [['babel-preset-expo', { jsxImportSource: 'react' }]],
    plugins: [
      // three.js ships static class blocks, which the Expo preset does not
      // enable. Without this, Metro fails on `three/build/three.cjs`.
      '@babel/plugin-transform-class-static-block',
      // Reanimated 4 moved its Babel plugin into react-native-worklets.
      // Must always be last.
      'react-native-worklets/plugin',
    ],
  };
};
