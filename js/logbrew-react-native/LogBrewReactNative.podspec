require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |spec|
  spec.name = "LogBrewReactNative"
  spec.version = package["version"]
  spec.summary = package["description"]
  spec.homepage = "https://github.com/LogBrewCo/sdk"
  spec.license = package["license"]
  spec.authors = { "LogBrew" => "opensource@logbrew.com" }
  spec.platforms = { :ios => "13.0" }
  spec.source = {
    :git => "https://github.com/LogBrewCo/sdk.git",
    :tag => "js/logbrew-react-native/v#{spec.version}"
  }
  spec.default_subspecs = "Core"
  spec.swift_versions = ["5.0"]
  spec.frameworks = "Security"
  spec.dependency "React-Core"

  spec.subspec "Core" do |core|
    core.source_files = "ios/**/*.{h,m,mm}"
    core.exclude_files = [
      "ios/AppleDiagnostics/**/*",
      "ios/Tests/**/*"
    ]
  end

  spec.subspec "AppleNativeDiagnostics" do |diagnostics|
    diagnostics.ios.deployment_target = "15.0"
    diagnostics.source_files = [
      "ios/AppleDiagnostics/**/*.{h,m,mm,swift}",
      "ios/GeneratedAppleDiagnostics/**/*.swift"
    ]
    diagnostics.dependency "#{spec.name}/Core"
    diagnostics.dependency "KSCrash/Recording", "2.6.0"
    diagnostics.pod_target_xcconfig = {
      "DEFINES_MODULE" => "YES",
      "SWIFT_VERSION" => "5.0"
    }
  end

  install_modules_dependencies(spec) if respond_to?(:install_modules_dependencies, true)
end
