import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native crash frame capture")
struct NativeCrashFrameCaptureTests {
    @Test("KSCrash frame and image keys produce ordered privacy-bounded frames")
    func validFramesUseExactSchema() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x1010, 0x202F, 0x3000])],
            images: [
                binaryImage(
                    start: 0x1000,
                    size: 0x100,
                    uuid: "11111111-2222-3333-4444-555555555555",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0x2000,
                    size: 0x100,
                    uuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 2,
                ),
                binaryImage(
                    start: 0x3000,
                    size: 0x100,
                    uuid: "01234567-89AB-CDEF-0123-456789ABCDEF",
                    cpuType: 0x0100_0007,
                    cpuSubtype: 3,
                ),
            ],
        )

        let attributes = try issueAttributes(for: report)
        let frames = try #require(attributes["nativeStackFrames"] as? [[String: Any]])

        #expect(
            Set(attributes.keys) == [
                "exception",
                "exceptionChain",
                "level",
                "metadata",
                "nativeStackFrames",
                "title",
            ],
        )
        try assertNativeCrashChain(attributes)
        #expect(frames as NSArray == expectedNativeStackFrames() as NSArray)
        #expect(frames.allSatisfy { Set($0.keys) == ["architecture", "imageUuid", "instructionOffset"] })

        let payload = try eventJSON(for: report)
        for forbidden in [
            "instruction_addr", "image_addr", "image_size", "symbol_name", "registers",
            "/Applications/Private.app/Private", "private-report-value",
        ] {
            #expect(!payload.contains(forbidden))
        }
    }

    @Test("invalid frames are omitted and the ordered result is capped at 32")
    func invalidFramesAreOmittedAndResultIsCapped() throws {
        let validAddresses: [Any] = (0 ..< 35).map { UInt64(0x4000 + $0) }
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: validAddresses + [0x4100, -1, "0x4000", 4000.5])],
            images: [
                binaryImage(
                    start: 0x4000,
                    size: 0x100,
                    uuid: "22222222-3333-4444-5555-666666666666",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 1,
                ),
                binaryImage(
                    start: 0x5000,
                    size: 0,
                    uuid: "33333333-4444-5555-6666-777777777777",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let frames = try #require(try issueAttributes(for: report)["nativeStackFrames"] as? [[String: Any]])

        #expect(frames.count == 32)
        #expect(frames.first?["instructionOffset"] as? String == "0000000000000000")
        #expect(frames.last?["instructionOffset"] as? String == "000000000000001f")
    }

    @Test("an instruction at the image end boundary is omitted")
    func imageEndBoundaryIsExcluded() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0x50FF, 0x5100])],
            images: [
                binaryImage(
                    start: 0x5000,
                    size: 0x100,
                    uuid: "33333333-4444-5555-6666-777777777777",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let frames = try #require(try issueAttributes(for: report)["nativeStackFrames"] as? [[String: Any]])

        #expect(frames.count == 1)
        #expect(frames[0]["instructionOffset"] as? String == "00000000000000ff")
    }
}

private func assertNativeCrashChain(_ attributes: [String: Any]) throws {
    let exception = try #require(attributes["exception"] as? [String: Any])
    let chain = try #require(attributes["exceptionChain"] as? [String: Any])
    let entries = try #require(chain["entries"] as? [[String: Any]])
    #expect(entries.count == 1)
    #expect(chain["truncated"] as? Bool == false)
    #expect(entries[0]["relationship"] as? String == "reported")
    #expect(entries[0]["type"] as? String == exception["type"] as? String)
    #expect(entries[0]["mechanism"] as? NSDictionary == exception["mechanism"] as? NSDictionary)
    #expect(entries[0]["messageState"] as? String == "not_captured")
    #expect(entries[0]["stackFramesState"] as? String == "not_captured")
    #expect(entries[0]["stackFrames"] == nil)
}
