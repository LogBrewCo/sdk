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
        .library(name: "LogBrewCrash", targets: ["LogBrewCrash"]),
        .executable(name: "ReadmeExample", targets: ["ReadmeExample"]),
        .executable(name: "RealUserSmoke", targets: ["RealUserSmoke"]),
        .executable(name: "TraceCorrelationExample", targets: ["TraceCorrelationExample"]),
    ],
    dependencies: [
        .package(url: "https://github.com/kstenerud/KSCrash.git", from: "2.5.1"),
    ],
    targets: [
        .target(name: "LogBrew"),
        .target(
            name: "LogBrewCrash",
            dependencies: [
                "LogBrew",
                .product(name: "Recording", package: "KSCrash"),
            ],
        ),
        .executableTarget(name: "ReadmeExample", dependencies: ["LogBrew"]),
        .executableTarget(name: "RealUserSmoke", dependencies: ["LogBrew"]),
        .executableTarget(name: "TraceCorrelationExample", dependencies: ["LogBrew"]),
        .testTarget(name: "LogBrewTests", dependencies: ["LogBrew"]),
        .testTarget(
            name: "LogBrewCrashTests",
            dependencies: ["LogBrew", "LogBrewCrash"],
        ),
    ],
)
