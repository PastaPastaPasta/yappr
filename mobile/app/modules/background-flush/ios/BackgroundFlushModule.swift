import ExpoModulesCore
import UIKit

/// `begin()` asks iOS for a few seconds of background time so the engine can
/// flush its storage after the app leaves the foreground (ENGINE.md §3.4);
/// `end(id)` gives it back. Expiry ends the task too, so it never leaks, and
/// a task is ended exactly once whichever comes first.
public class BackgroundFlushModule: Module {
  private var live = Set<Int>()
  private let lock = NSLock()

  private func finish(_ id: Int) {
    lock.lock()
    let wasLive = live.remove(id) != nil
    lock.unlock()
    if wasLive {
      UIApplication.shared.endBackgroundTask(UIBackgroundTaskIdentifier(rawValue: id))
    }
  }

  public func definition() -> ModuleDefinition {
    Name("BackgroundFlush")

    Function("begin") { () -> Int in
      var id = UIBackgroundTaskIdentifier.invalid.rawValue
      id = UIApplication.shared.beginBackgroundTask(withName: "yappr.engine.flush") { [weak self] in
        self?.finish(id)
      }.rawValue
      if id != UIBackgroundTaskIdentifier.invalid.rawValue {
        self.lock.lock()
        self.live.insert(id)
        self.lock.unlock()
      }
      return id
    }

    Function("end") { (id: Int) in
      self.finish(id)
    }
  }
}
