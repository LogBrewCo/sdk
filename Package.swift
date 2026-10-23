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
        .library(name: "LogBrewObjC", targets: ["LogBrewObjC"]),
    ],
    dependencies: [
        .package(url: "https://github.com/kstenerud/KSCrash.git", from: "2.5.1"),
    ],
    targets: [
        .target(
            name: "LogBrewObjC",
            path: "objc/logbrew-objc",
            sources: ["src"],
            publicHeadersPath: "include",
        ),
        .target(
            name: "LogBrew",
            path: "swift/logbrew-swift/Sources/LogBrew",
        ),
        .testTarget(
            name: "LogBrewTests",
            dependencies: ["LogBrew"],
            path: "swift/logbrew-swift/Tests/LogBrewTests",
        ),
        .target(
            name: "LogBrewCrash",
            dependencies: [
                "LogBrew",
                .product(name: "Recording", package: "KSCrash"),
            ],
            path: "swift/logbrew-swift/Sources/LogBrewCrash",
        ),
        .executableTarget(
            name: "LogBrewHangStoreProcessHelper",
            dependencies: ["LogBrew", "LogBrewCrash"],
            path: "swift/logbrew-swift/Tests/LogBrewHangStoreProcessHelper",
        ),
        .testTarget(
            name: "LogBrewCrashTests",
            dependencies: [
                "LogBrew",
                "LogBrewCrash",
                "LogBrewHangStoreProcessHelper",
            ],
            path: "swift/logbrew-swift/Tests/LogBrewCrashTests",
        ),
    ],
)
