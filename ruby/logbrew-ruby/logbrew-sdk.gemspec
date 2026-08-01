Gem::Specification.new do |spec|
  spec.name = "logbrew-sdk"
  spec.version = "0.1.3"
  spec.summary = "Public LogBrew Ruby SDK"
  spec.description = "Public LogBrew Ruby SDK with automatic Rails request/error capture and standard-library delivery."
  spec.authors = ["LogBrew"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6"
  spec.homepage = "https://github.com/LogBrewCo/sdk"
  spec.metadata = {
    "source_code_uri" => "https://github.com/LogBrewCo/sdk"
  }
  spec.files = Dir[
    "README.md",
    "lib/**/*.rb",
    "examples/**/*.rb",
    "examples/Makefile"
  ]
  spec.require_paths = ["lib"]
end
