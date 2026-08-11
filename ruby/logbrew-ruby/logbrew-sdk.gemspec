require_relative "lib/logbrew/version"

Gem::Specification.new("logbrew-sdk", LogBrew::VERSION) do |spec|
  spec.summary = "Public LogBrew Ruby SDK"
  spec.description = "Public LogBrew Ruby SDK with typed issue diagnostics, automatic Rails request/error capture, and standard-library delivery."
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
