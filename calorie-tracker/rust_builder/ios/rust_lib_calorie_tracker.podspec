#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
# Run `pod lib lint rust_lib_calorie_tracker.podspec` to validate before publishing.
#
Pod::Spec.new do |s|
  s.name             = 'rust_lib_calorie_tracker'
  s.version          = '0.0.1'
  s.summary          = 'A new Flutter FFI plugin project.'
  s.description      = <<-DESC
A new Flutter FFI plugin project.
                       DESC
  s.homepage         = 'http://example.com'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'Your Company' => 'email@example.com' }

  # This will ensure the source files in Classes/ are included in the native
  # builds of apps using this FFI plugin. Podspec does not support relative
  # paths, so Classes contains a forwarder C file that relatively imports
  # `../src/*` so that the C sources can be shared among all target platforms.
  s.source           = { :path => '.' }
  s.source_files = 'Classes/**/*'
  s.dependency 'Flutter'
  # mobile_scanner (QR pairing) sets the floor for the whole app at 15.5.
  s.platform = :ios, '15.5'

  # The Rust static library reaches SystemConfiguration for the local network
  # interfaces Iroh enumerates, and Security for the platform certificate
  # verifier rustls uses. Neither is linked by default and a static library
  # cannot pull them in itself, so without this the build dies on
  # `Undefined symbol: _kSCNetworkInterfaceType*` while linking *this* pod into
  # a dynamic framework — before the app target is reached at all.
  #
  # Editing this file does not take effect on its own: CocoaPods caches the
  # generated xcconfig, so run `pod install` in `ios/` after changing it.
  s.frameworks = 'SystemConfiguration', 'Security'

  s.swift_version = '5.0'

  s.script_phase = {
    :name => 'Build Rust library',
    # First argument is relative path to the `rust` folder, second is name of rust library
    :script => 'sh "$PODS_TARGET_SRCROOT/../cargokit/build_pod.sh" ../../rust rust_lib_calorie_tracker',
    :execution_position => :before_compile,
    :input_files => ['${BUILT_PRODUCTS_DIR}/cargokit_phony'],
    # Let XCode know that the static library referenced in -force_load below is
    # created by this build step.
    :output_files => ["${BUILT_PRODUCTS_DIR}/librust_lib_calorie_tracker.a"],
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    # Flutter.framework does not contain a i386 slice.
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386',
    'OTHER_LDFLAGS' => '-force_load ${BUILT_PRODUCTS_DIR}/librust_lib_calorie_tracker.a',
  }
end