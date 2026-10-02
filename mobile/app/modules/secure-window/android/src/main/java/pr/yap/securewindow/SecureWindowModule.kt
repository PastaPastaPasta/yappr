package pr.yap.securewindow

import android.view.WindowManager
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * FLAG_SECURE on the app's window: a blank Recents thumbnail, and no screenshots
 * or recordings. Used instead of expo-screen-capture on Android, which registers a
 * screenshot callback at startup, so Android 14+ would tell the user "Yappr detected
 * this screenshot" on every screen.
 *
 * The flag belongs to one Activity window, so it is re-applied whenever an Activity
 * comes to the foreground (a font-size or locale change recreates the Activity).
 */
class SecureWindowModule : Module() {
  @Volatile private var secure = false

  override fun definition() = ModuleDefinition {
    Name("SecureWindow")

    Function("setSecure") { on: Boolean ->
      secure = on
      apply()
    }

    OnActivityEntersForeground {
      apply()
    }
  }

  private fun apply() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread {
      // Read the latest value on the UI thread, so calls posted out of order still settle right.
      if (secure) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
    }
  }
}
