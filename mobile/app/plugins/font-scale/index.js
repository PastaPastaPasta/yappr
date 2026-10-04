/**
 * Android font-size changes without recreating MainActivity
 * (NEW-R-A-01, config-change-resets-nav).
 *
 * Android recreates an activity for every configuration change its
 * `android:configChanges` does not list. The template lists neither
 * `fontScale` nor `density`, so changing the system font size while Yappr was
 * open recreated MainActivity in the same process: React Native mounted the
 * app afresh, and the user lost their place (back on Home) and anything
 * typed on the screen they were on.
 *
 * - `fontScale` is added: React Native handles a font-scale change in place.
 *   `ReactHost.onConfigurationChanged` refreshes its display metrics and
 *   re-lays out the surfaces, and Fabric re-measures text for the new
 *   `fontSizeMultiplier` (`enableFontScaleChangesUpdatingLayout`, on by
 *   default in 0.86).
 * - JS hears of the new scale (`useWindowDimensions().fontScale`, which sizes
 *   the Android tab bar and the text fields) only when DeviceInfo's
 *   `onHostResume` sees it changed, so a change made without leaving the app
 *   (Quick Settings, an accessibility shortcut, `adb`) would leave it stale.
 *   MainActivity's `onConfigurationChanged` asks DeviceInfo to check now.
 * - Native views that turned an sp size into pixels when a prop was set keep
 *   the old size: Android's TextView does not redo `setTextSize(sp)` on a
 *   configuration change. React Native's own TextInput redoes it
 *   (`ReactEditText.onConfigurationChanged`, under the same flag), but
 *   react-native-screens sets the native-stack header title's size (the 20 sp
 *   of src/ui/stack-options.ts, D-L4a-005) only in
 *   `ScreenStackHeaderConfig.onUpdate`, run on a prop change or an attach.
 *   So `onConfigurationChanged` runs `onUpdate` on every header config in the
 *   window; it returns at once for a header that is not on top, and those
 *   run it again when they attach.
 * - `density` (Display size) is left out on purpose: React Native only
 *   partly re-lays out for it in place (props already converted to pixels
 *   and native views sized from resources keep the old density), so that
 *   change still recreates the activity.
 */
const { AndroidConfig, withAndroidManifest, withMainActivity } = require('expo/config-plugins');

const CONFIG_CHANGE = 'fontScale';
const TAG = 'yappr-font-scale';

const IMPORTS = [
  'android.content.res.Configuration',
  'android.view.View',
  'android.view.ViewGroup',
  'com.facebook.react.ReactApplication',
  'com.facebook.react.bridge.LifecycleEventListener',
  'com.swmansion.rnscreens.ScreenStackHeaderConfig',
];

const ON_CONFIGURATION_CHANGED = `
  // @generated begin ${TAG} (plugins/font-scale)
  /**
   * A font-size change no longer recreates this activity (fontScale is in its configChanges).
   * React Native re-lays out its text itself, but tells JS the new scale only on resume:
   * have DeviceInfo compare it now, once React Native's own handling has run. Header titles
   * keep the pixel size their sp size had when set, until react-native-screens sets it again.
   */
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    window.decorView.post {
      updateStackHeaders(window.decorView)
      val context = (application as ReactApplication).reactHost?.currentReactContext ?: return@post
      (context.getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()
    }
  }

  /** Has every react-native-screens header in the window apply its props (title size in sp) again. */
  private fun updateStackHeaders(view: View) {
    if (view is ScreenStackHeaderConfig) {
      view.onUpdate()
    } else if (view is ViewGroup) {
      for (index in 0 until view.childCount) updateStackHeaders(view.getChildAt(index))
    }
  }
  // @generated end ${TAG}
`;

/** `configChanges` with `fontScale` added once, order kept. */
function withFontScaleConfigChange(configChanges) {
  const changes = (configChanges ?? '').split('|').filter(Boolean);
  return changes.includes(CONFIG_CHANGE) ? changes.join('|') : [...changes, CONFIG_CHANGE].join('|');
}

/**
 * MainActivity.kt with the `onConfigurationChanged` override and its
 * imports. Fails the prebuild if the template changed shape (a Java
 * MainActivity, or one that already overrides it), instead of skipping.
 */
function withConfigurationHandler(source, language) {
  if (source.includes(`@generated begin ${TAG}`)) return source;
  if (language !== 'kt') throw new Error('font-scale: expected a Kotlin MainActivity.');
  if (source.includes('fun onConfigurationChanged(')) {
    throw new Error('font-scale: MainActivity already overrides onConfigurationChanged.');
  }
  const header = source.match(/^package [^\n]+\n/);
  const body = source.lastIndexOf('}');
  if (!header || body === -1 || !/class MainActivity\b/.test(source)) {
    throw new Error('font-scale: cannot find the MainActivity class in MainActivity.kt.');
  }
  const missing = IMPORTS.filter((name) => !new RegExp(`^import ${name.replace(/\./g, '\\.')}$`, 'm').test(source));
  const withBody = source.slice(0, body).replace(/\s*$/, '\n') + ON_CONFIGURATION_CHANGED + source.slice(body);
  const imports = missing.map((name) => `import ${name}\n`).join('');
  return withBody.replace(header[0], `${header[0]}${imports}`);
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withFontScale = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    activity.$['android:configChanges'] = withFontScaleConfigChange(activity.$['android:configChanges']);
    return cfg;
  });
  return withMainActivity(config, (cfg) => {
    cfg.modResults.contents = withConfigurationHandler(cfg.modResults.contents, cfg.modResults.language);
    return cfg;
  });
};

module.exports = withFontScale;
module.exports.withFontScaleConfigChange = withFontScaleConfigChange;
module.exports.withConfigurationHandler = withConfigurationHandler;
