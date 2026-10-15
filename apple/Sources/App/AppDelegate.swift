import UIKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UINavigationController(rootViewController: GameViewController())
        window.makeKeyAndVisible(); self.window = window
        return true
    }
    func application(_ application: UIApplication, continue activity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Invocation data is intentionally not executed or forwarded to the
        // native bridge. Every invocation opens the locally bundled game.
        activity.activityType == NSUserActivityTypeBrowsingWeb
    }
}
