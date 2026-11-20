import UIKit
import Flutter

@UIApplicationMain
@objc class AppDelegate: FlutterAppDelegate {
  /// The Universal Link the app was opened with, until Dart asks for it.
  private var initialLink: String?
  private var linkChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    if let controller = window?.rootViewController as? FlutterViewController {
      // Same channel as Android's MainActivity: Dart's `_handleDeepLink`.
      let channel = FlutterMethodChannel(
        name: "app.atomicdata.app/deeplink", binaryMessenger: controller.binaryMessenger)
      channel.setMethodCallHandler { [weak self] call, result in
        if call.method == "getInitialLink" {
          result(self?.initialLink)
          self?.initialLink = nil
        } else {
          result(FlutterMethodNotImplemented)
        }
      }
      linkChannel = channel
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  /// A Universal Link (the mailed sign-in link, https://atomic.place/signin).
  override func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    if userActivity.activityType == NSUserActivityTypeBrowsingWeb,
      let link = userActivity.webpageURL?.absoluteString
    {
      if let channel = linkChannel {
        channel.invokeMethod("onNewLink", arguments: link)
      } else {
        initialLink = link
      }
      return true
    }
    return super.application(
      application, continue: userActivity, restorationHandler: restorationHandler)
  }
}
