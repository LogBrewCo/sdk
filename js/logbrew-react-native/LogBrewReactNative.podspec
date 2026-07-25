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
    :tag => "react-native-v#{spec.version}"
  }
  spec.source_files = "ios/**/*.{h,m,mm}"
  spec.exclude_files = "ios/Tests/**/*"
  spec.dependency "React-Core"

  install_modules_dependencies(spec) if respond_to?(:install_modules_dependencies, true)
end
