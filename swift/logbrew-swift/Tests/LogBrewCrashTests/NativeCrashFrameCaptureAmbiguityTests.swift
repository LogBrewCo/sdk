import Foundation
@testable import LogBrewCrash
import Testing

@Suite("Apple native crash frame capture ambiguity")
struct NativeCrashFrameCaptureAmbiguityTests {
    @Test("overlapping checked image ranges fail closed for the structured stack")
    func overlappingImagesFailClosed() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x6080])],
            images: [
                binaryImage(
                    start: 0x6000,
                    size: 0x100,
                    uuid: "44444444-5555-6666-7777-888888888888",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0x6040,
                    size: 0x100,
                    uuid: "55555555-6666-7777-8888-999999999999",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let attributes = try issueAttributes(for: report)

        #expect(attributes["nativeStackFrames"] == nil)
        #expect(Set(attributes.keys) == ["level", "metadata", "title"])
        #expect(attributes["title"] as? String == "Native application crash")
        #expect(attributes["level"] as? String == "critical")
        #expect(attributes["metadata"] as? [String: Any] as NSDictionary? == [
            "crash.mechanism": "signal",
            "crash.replayed": true,
        ] as NSDictionary)
    }

    @Test("duplicate UUID and architecture identity fails closed for the structured stack")
    func duplicateImageIdentityFailsClosed() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x7010])],
            images: [
                binaryImage(
                    start: 0x7000,
                    size: 0x100,
                    uuid: "66666666-7777-8888-9999-AAAAAAAAAAAA",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0x8000,
                    size: 0x100,
                    uuid: "66666666-7777-8888-9999-AAAAAAAAAAAA",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        #expect(try issueAttributes(for: report)["nativeStackFrames"] == nil)
    }

    @Test("unrelated duplicate image identity does not discard a uniquely mapped frame")
    func unrelatedDuplicateImageIdentityIsIgnored() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x9010])],
            images: [
                binaryImage(
                    start: 0x9000,
                    size: 0x100,
                    uuid: "77777777-8888-9999-AAAA-BBBBBBBBBBBB",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0xA000,
                    size: 0x100,
                    uuid: "88888888-9999-AAAA-BBBB-CCCCCCCCCCCC",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 2,
                ),
                binaryImage(
                    start: 0xB000,
                    size: 0x100,
                    uuid: "88888888-9999-AAAA-BBBB-CCCCCCCCCCCC",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 2,
                ),
            ],
        )

        let frames = try #require(
            try issueAttributes(for: report)["nativeStackFrames"] as? [[String: Any]],
        )

        #expect(frames.count == 1)
        #expect(frames[0]["imageUuid"] as? String == "77777777-8888-9999-aaaa-bbbbbbbbbbbb")
        #expect(frames[0]["architecture"] as? String == "arm64")
        #expect(frames[0]["instructionOffset"] as? String == "0000000000000010")
    }

    @Test("multiple crashed threads fail closed for the structured stack")
    func multipleCrashedThreadsFailClosed() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x9010]), crashedThread(addresses: [0x9020])],
            images: [
                binaryImage(
                    start: 0x9000,
                    size: 0x100,
                    uuid: "77777777-8888-9999-AAAA-BBBBBBBBBBBB",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        #expect(try issueAttributes(for: report)["nativeStackFrames"] == nil)
    }

    @Test("zero crashed threads preserve the issue without a structured stack")
    func zeroCrashedThreadsPreserveIssue() throws {
        var thread = crashedThread(addresses: [0x9010])
        thread["crashed"] = false
        let report = makeKSCrashReport(
            threads: [thread],
            images: [
                binaryImage(
                    start: 0x9000,
                    size: 0x100,
                    uuid: "77777777-8888-9999-AAAA-BBBBBBBBBBBB",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let attributes = try issueAttributes(for: report)

        #expect(attributes["nativeStackFrames"] == nil)
        #expect(attributes["title"] as? String == "Native application crash")
        #expect(attributes["level"] as? String == "critical")
    }
}
