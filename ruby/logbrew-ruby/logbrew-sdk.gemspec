Gem::Specification.new do |spec|
  spec.name = "logbrew-sdk"
  spec.version = "0.1.0"
  spec.summary = "Public LogBrew Ruby SDK"
  spec.description = "Public LogBrew Ruby SDK for building, validating, and flushing event batches."
  spec.authors = ["LogBrew"]
  spec.license = "MIT"
  spec.required_ruby_version = ">= 2.6"
  spec.homepage = "https://github.com/LogBrewCo/LogBrewCo-sdk"
  spec.metadata = {
    "source_code_uri" => "https://github.com/LogBrewCo/LogBrewCo-sdk"
  }
  spec.files = Dir[
    "README.md",
    "lib/**/*.rb",
    "examples/**/*.rb",
    "examples/Makefile"
  ]
  spec.require_paths = ["lib"]
end
