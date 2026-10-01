import ExpoModulesCore
import UIKit

/// `begin()` asks iOS for a few seconds of background time so the engine can
/// flush its storage after the app leaves the foreground (ENGINE.md §3.4);
/// `end(id)` gives it back. Expiry ends the task too, so it never leaks.
public class BackgroundFlushModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BackgroundFlush")

    Function("begin") { () -> Int in
      var task = UIBackgroundTaskIdentifier.invalid
      task = UIApplication.shared.beginBackgroundTask(withName: "yappr.engine.flush") {
        UIApplication.shared.endBackgroundTask(task)
      }
      return task.rawValue
    }

    Function("end") { (id: Int) in
      let task = UIBackgroundTaskIdentifier(rawValue: id)
      if task != .invalid {
        UIApplication.shared.endBackgroundTask(task)
      }
    }
  }
}
