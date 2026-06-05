// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "logbrew-swift",
    platforms: [
        .macOS(.v13),
        .iOS(.v15),
        .tvOS(.v15),
        .watchOS(.v8),
    ],
    products: [
        .library(name: "LogBrew", targets: ["LogBrew"]),
        .executable(name: "ReadmeExample", targets: ["ReadmeExample"]),
        .executable(name: "RealUserSmoke", targets: ["RealUserSmoke"]),
    ],
    targets: [
        .target(name: "LogBrew"),
        .executableTarget(name: "ReadmeExample", dependencies: ["LogBrew"]),
        .executableTarget(name: "RealUserSmoke", dependencies: ["LogBrew"]),
        .testTarget(name: "LogBrewTests", dependencies: ["LogBrew"]),
    ],
)
