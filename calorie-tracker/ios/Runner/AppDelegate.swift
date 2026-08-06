import Flutter
import UIKit
import UserNotifications
import workmanager_apple

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Required by flutter_local_notifications: without a delegate, a tap on a
    // question about a meal never reaches Dart and the deep link goes nowhere.
    // The cast is the plugin's own recipe — FlutterAppDelegate conforms, but
    // only on the SDKs where the protocol exists.
    UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate

    // A background drain runs in an engine of its own, which starts with no
    // plugins attached — so path_provider, secure storage and the Rust bridge
    // would all be missing exactly where nobody is watching. Registered before
    // the launch handler below, because iOS may call that during launch.
    WorkmanagerPlugin.setPluginRegistrantCallback { registry in
      GeneratedPluginRegistrant.register(with: registry)
    }

    // Must happen before the app finishes launching, per BGTaskScheduler: iOS
    // refuses a submit for an identifier it has no handler for. The string is
    // `estimationTaskName` in lib/services/background_estimation.dart and
    // BGTaskSchedulerPermittedIdentifiers in Info.plist — all three have to
    // agree or the task silently never runs.
    WorkmanagerPlugin.registerBGProcessingTask(
      withIdentifier: "dev.atomicdata.calorieTracker.estimate")

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
  }
}
