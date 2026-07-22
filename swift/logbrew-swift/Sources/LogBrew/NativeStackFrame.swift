import Foundation

@_spi(CrashReplay)
public enum NativeStackArchitecture: String, Codable, Equatable, Sendable {
    case arm64
    case arm64e
    case x8664 = "x86_64"
}

@_spi(CrashReplay)
public struct NativeStackFrame: Codable, Equatable, Sendable {
    public let imageUuid: String
    public let architecture: NativeStackArchitecture
    public let instructionOffset: String

    public init(
        imageUuid: String,
        architecture: NativeStackArchitecture,
        instructionOffset: String,
    ) {
        self.imageUuid = imageUuid
        self.architecture = architecture
        self.instructionOffset = instructionOffset
    }
}
