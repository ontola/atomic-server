import ARKit
import Flutter
import RoomPlan
import UIKit
import simd

/// Apple RoomPlan scanning for the Dart `PlatformRoomScanner`.
/// Channel `io.ontola.atomic_buildings/roomscan`:
///   isSupported -> Bool
///   scan        -> String (JSON of the contract in lib/src/roomplan.dart) or nil on cancel
///   endSession  -> nil; the next scan starts a new ARKit world and `sessionId`
///   mergeRooms  -> String `{"rooms": [<scan JSON>, ...]}` (iOS 17 StructureBuilder) or nil
/// Consecutive scans share one RoomCaptureView and so one ARSession (see `SharedScan`),
/// which keeps their ARKit coordinates in one frame: the JSON then carries `sessionId`
/// and `worldShared: true` on every scan after the first.
/// Written without a Mac to compile on; see README "Scanning rooms".
final class RoomScanPlugin: NSObject, FlutterPlugin {
  private var pending: FlutterResult?

  static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(
      name: "io.ontola.atomic_buildings/roomscan", binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(RoomScanPlugin(), channel: channel)
  }

  func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "isSupported":
      result(RoomCaptureSession.isSupported)
    case "scan":
      guard RoomCaptureSession.isSupported else {
        return result(FlutterError(code: "unsupported", message: "RoomPlan needs a LiDAR device", details: nil))
      }
      guard pending == nil, let presenter = RoomScanPlugin.topViewController() else {
        return result(FlutterError(code: "busy", message: "No view controller, or a scan is running", details: nil))
      }
      pending = result
      let scanner = RoomScanViewController { [weak self] json, error in
        guard let self = self, let reply = self.pending else { return }
        self.pending = nil
        if let error = error {
          reply(FlutterError(code: "scan_failed", message: error.localizedDescription, details: nil))
        } else {
          reply(json)  // nil when cancelled
        }
      }
      scanner.modalPresentationStyle = .fullScreen
      presenter.present(scanner, animated: true)
    case "endSession":
      SharedScan.shared.reset()
      result(nil)
    case "mergeRooms":
      guard #available(iOS 17.0, *), SharedScan.shared.rooms.count >= 2 else { return result(nil) }
      let (rooms, id) = (SharedScan.shared.rooms, SharedScan.shared.sessionId)
      Task { @MainActor in
        do {
          let merged = try await StructureBuilder(options: [.beautifyObjects]).capturedStructure(from: rooms)
          let list = merged.rooms.map { RoomScanViewController.dictionary($0, sessionId: id, shared: true) }
          let data = try JSONSerialization.data(withJSONObject: ["rooms": list])
          result(String(decoding: data, as: UTF8.self))
        } catch {
          result(FlutterError(code: "merge_failed", message: error.localizedDescription, details: nil))
        }
      }
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private static func topViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    var top = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
    while let presented = top?.presentedViewController { top = presented }
    return top
  }
}

/// One RoomCaptureView (so one ARSession) for all scans until `endSession`, so ARKit
/// world coordinates stay shared. Assumption (untested, no Mac): on iOS 17,
/// `stop(pauseARSession: false)` leaves the session tracking and a later `run` on the
/// same RoomCaptureSession does not reset the world origin. On iOS 16 nothing is
/// assumed: scans are never reported as `worldShared` and Dart matches doors instead.
final class SharedScan {
  static let shared = SharedScan()
  private(set) var sessionId = UUID().uuidString
  private var view: RoomCaptureView?
  var rooms: [CapturedRoom] = []  // this session's rooms, for mergeRooms
  var scans = 0

  func captureView() -> RoomCaptureView {
    if let view = view { return view }
    let created = RoomCaptureView(frame: .zero)
    view = created
    return created
  }

  func reset() {
    view?.captureSession.stop()
    view = nil
    rooms = []
    scans = 0
    sessionId = UUID().uuidString
  }
}

/// Full-screen RoomCaptureView with Start and Done (and Cancel) buttons.
final class RoomScanViewController: UIViewController, RoomCaptureSessionDelegate {
  private let finish: (String?, Error?) -> Void
  private let captureView = SharedScan.shared.captureView()
  private var continued = false  // this scan reuses the previous scan's ARKit world
  private let primary = UIButton(type: .system)
  private let cancel = UIButton(type: .system)
  private var running = false
  private var finished = false

  init(finish: @escaping (String?, Error?) -> Void) {
    self.finish = finish
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    captureView.removeFromSuperview()  // it may still sit in the previous scan's view
    captureView.frame = view.bounds
    captureView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    captureView.captureSession.delegate = self
    view.addSubview(captureView)

    primary.setTitle("Start", for: .normal)
    primary.addTarget(self, action: #selector(primaryTapped), for: .touchUpInside)
    cancel.setTitle("Cancel", for: .normal)
    cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
    for b in [primary, cancel] {
      b.translatesAutoresizingMaskIntoConstraints = false
      b.backgroundColor = UIColor.black.withAlphaComponent(0.6)
      b.setTitleColor(.white, for: .normal)
      b.titleLabel?.font = .preferredFont(forTextStyle: .headline)
      b.layer.cornerRadius = 12
      b.contentEdgeInsets = UIEdgeInsets(top: 12, left: 24, bottom: 12, right: 24)
      view.addSubview(b)
    }
    NSLayoutConstraint.activate([
      primary.centerXAnchor.constraint(equalTo: view.centerXAnchor),
      primary.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
      cancel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 16),
      cancel.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
    ])
  }

  @objc private func primaryTapped() {
    if running {
      primary.isEnabled = false
      primary.setTitle("Processing...", for: .normal)
      stopSession()  // didEndWith follows
    } else {
      running = true
      primary.setTitle("Done", for: .normal)
      // No `.resetTracking`: RoomCaptureSession.run takes only its own Configuration, and
      // the shared view's ARSession is left running between scans (see `stopSession`).
      continued = SharedScan.shared.scans > 0 && sessionStillTracking()
      captureView.captureSession.run(configuration: RoomCaptureSession.Configuration())
    }
  }

  @objc private func cancelTapped() {
    finished = true
    if running { stopSession() }
    dismiss(animated: true) { self.finish(nil, nil) }
  }

  /// Stops capturing but, on iOS 17, keeps ARKit tracking so the next scan shares the world.
  private func stopSession() {
    if #available(iOS 17.0, *) {
      captureView.captureSession.stop(pauseARSession: false)
    } else {
      captureView.captureSession.stop()
    }
  }

  private func sessionStillTracking() -> Bool {
    guard #available(iOS 17.0, *) else { return false }
    return captureView.captureSession.arSession.currentFrame?.camera.trackingState == .normal
  }

  // MARK: RoomCaptureSessionDelegate

  func captureSession(_ session: RoomCaptureSession, didEndWith data: CapturedRoomData, error: Error?) {
    if finished { return }
    finished = true
    Task { @MainActor in
      do {
        if let error = error { throw error }
        let room = try await RoomBuilder(options: [.beautifyObjects]).capturedRoom(from: data)
        let shared = SharedScan.shared
        let json = try RoomScanViewController.serialize(room, sessionId: shared.sessionId, shared: self.continued)
        shared.rooms.append(room)
        shared.scans += 1
        self.dismiss(animated: true) { self.finish(json, nil) }
      } catch {
        self.dismiss(animated: true) { self.finish(nil, error) }
      }
    }
  }

  // MARK: JSON contract

  private static func serialize(_ room: CapturedRoom, sessionId: String, shared: Bool) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: dictionary(room, sessionId: sessionId, shared: shared))
    return String(decoding: data, as: UTF8.self)
  }

  static func dictionary(_ room: CapturedRoom, sessionId: String, shared: Bool) -> [String: Any] {
    var surfaces: [[String: Any]] = []
    func add(_ list: [CapturedRoom.Surface], _ category: String) {
      for s in list {
        var d = item(s.identifier, category, s.transform, s.dimensions, s.confidence)
        if #available(iOS 17.0, *), let parent = s.parentIdentifier {
          d["parentId"] = parent.uuidString
        }
        surfaces.append(d)
      }
    }
    add(room.walls, "wall")
    add(room.doors, "door")
    add(room.windows, "window")
    add(room.openings, "opening")
    if #available(iOS 17.0, *) { add(room.floors, "floor") }

    let objects = room.objects.map {
      item($0.identifier, name($0.category), $0.transform, $0.dimensions, $0.confidence)
    }
    return ["surfaces": surfaces, "objects": objects, "sessionId": sessionId, "worldShared": shared]
  }

  private static func item(
    _ id: UUID, _ category: String, _ t: simd_float4x4, _ dims: simd_float3,
    _ confidence: CapturedRoom.Confidence
  ) -> [String: Any] {
    // Column-major, as the contract in lib/src/roomplan.dart says.
    var matrix: [Double] = []
    for column in [t.columns.0, t.columns.1, t.columns.2, t.columns.3] {
      matrix.append(Double(column.x))
      matrix.append(Double(column.y))
      matrix.append(Double(column.z))
      matrix.append(Double(column.w))
    }
    let level: String
    switch confidence {
    case .high: level = "high"
    case .medium: level = "medium"
    default: level = "low"
    }
    return [
      "category": category,
      "id": id.uuidString,
      "transform": matrix,
      "dimensions": [Double(dims.x), Double(dims.y), Double(dims.z)] as [Double],
      "confidence": level,
    ]
  }

  private static func name(_ c: CapturedRoom.Object.Category) -> String {
    switch c {
    case .storage: return "storage"
    case .refrigerator: return "refrigerator"
    case .stove: return "stove"
    case .bed: return "bed"
    case .sink: return "sink"
    case .washerDryer: return "washerDryer"
    case .toilet: return "toilet"
    case .bathtub: return "bathtub"
    case .oven: return "oven"
    case .dishwasher: return "dishwasher"
    case .table: return "table"
    case .sofa: return "sofa"
    case .chair: return "chair"
    case .fireplace: return "fireplace"
    case .television: return "television"
    case .stairs: return "stairs"
    default: return "object"
    }
  }
}
