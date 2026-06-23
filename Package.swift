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
    ],
    targets: [
        .target(
            name: "LogBrew",
            path: "swift/logbrew-swift/Sources/LogBrew"
        ),
        .testTarget(
            name: "LogBrewTests",
            dependencies: ["LogBrew"],
            path: "swift/logbrew-swift/Tests/LogBrewTests"
        ),
    ],
)
