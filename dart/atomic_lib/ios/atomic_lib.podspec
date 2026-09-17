#
# To learn more about a Podspec see http://guides.cocoapods.org/syntax/podspec.html.
#
Pod::Spec.new do |s|
  s.name             = 'atomic_lib'
  s.version          = '0.1.0'
  s.summary          = 'Atomic Data SDK for Flutter (FFI plugin).'
  s.description      = <<-DESC
Atomic Data local-first Flutter SDK backed by atomic_lib (Rust).
                       DESC
  s.homepage         = 'https://atomicdata.dev'
  s.license          = { :file => '../LICENSE' }
  s.author           = { 'Ontola' => 'info@ontola.io' }

  s.source           = { :path => '.' }
  s.source_files = 'Classes/**/*'
  s.dependency 'Flutter'
  s.platform = :ios, '12.0'
  s.swift_version = '5.0'

  s.script_phase = {
    :name => 'Build Rust library',
    :script => 'sh "$PODS_TARGET_SRCROOT/../cargokit/build_pod.sh" ../rust rust_lib_atomic_lib',
    :execution_position => :before_compile,
    :input_files => ['${BUILT_PRODUCTS_DIR}/cargokit_phony'],
    :output_files => ["${BUILT_PRODUCTS_DIR}/librust_lib_atomic_lib.a"],
  }
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'EXCLUDED_ARCHS[sdk=iphonesimulator*]' => 'i386',
    'OTHER_LDFLAGS' => '-force_load ${BUILT_PRODUCTS_DIR}/librust_lib_atomic_lib.a',
  }
end
