import Foundation
@_spi(CrashReplay) import LogBrew
@testable import LogBrewCrash
import Testing

@Suite("Apple native crash frame capture validation")
struct NativeCrashFrameCaptureValidationTests {
    @Test("malformed image identity, architecture, range, and overflow omit their frames")
    func malformedImagesOmitFrames() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0xA010, 0xB010, 0xC010, UInt64.max - 4, 0xD010])],
            images: [
                binaryImage(start: 0xA000, size: 0x100, uuid: "not-a-uuid", cpuType: 0x0100_000C, cpuSubtype: 0),
                binaryImage(
                    start: 0xB000,
                    size: 0x100,
                    uuid: "88888888-9999-AAAA-BBBB-CCCCCCCCCCCC",
                    cpuType: 123,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0xC000,
                    size: -1,
                    uuid: "99999999-AAAA-BBBB-CCCC-DDDDDDDDDDDD",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: UInt64.max - 8,
                    size: 16,
                    uuid: "AAAAAAAA-BBBB-CCCC-DDDD-FFFFFFFFFFFF",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: 0xD000,
                    size: 0x100,
                    uuid: "BBBBBBBB-CCCC-DDDD-EEEE-000000000000",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let frames = try #require(try issueAttributes(for: report)["nativeStackFrames"] as? [[String: Any]])

        #expect(frames.count == 1)
        #expect(frames[0] as NSDictionary == [
            "imageUuid": "bbbbbbbb-cccc-dddd-eeee-000000000000",
            "architecture": "arm64",
            "instructionOffset": "0000000000000010",
        ] as NSDictionary)
    }

    @Test("unsigned 64-bit ranges remain exact and overflowing ranges are omitted")
    func highUnsignedRangesUseCheckedAddition() throws {
        let validStart = UInt64.max - 0x200
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [validStart + 0x10, UInt64.max - 4])],
            images: [
                binaryImage(
                    start: validStart,
                    size: UInt64(0x100),
                    uuid: "DDDDDDDD-EEEE-FFFF-1111-222222222222",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
                binaryImage(
                    start: UInt64.max - 8,
                    size: UInt64(16),
                    uuid: "EEEEEEEE-FFFF-1111-2222-333333333333",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )

        let frames = try #require(try issueAttributes(for: report)["nativeStackFrames"] as? [[String: Any]])

        #expect(frames.count == 1)
        #expect(frames[0] as NSDictionary == [
            "imageUuid": "dddddddd-eeee-ffff-1111-222222222222",
            "architecture": "arm64",
            "instructionOffset": "0000000000000010",
        ] as NSDictionary)
    }

    @Test("instruction offsets reject non-ASCII hexadecimal lookalikes")
    func instructionOffsetsRequireAsciiLowercaseHex() throws {
        let client = try makeNativeFrameClient()
        let frame = NativeStackFrame(
            imageUuid: "dddddddd-eeee-ffff-1111-222222222222",
            architecture: .arm64,
            instructionOffset: "000000000000000ａ",
        )

        #expect(throws: SdkError.self) {
            try client.issue(
                "native-frame-invalid-offset",
                timestamp: "2026-07-20T00:00:00Z",
                attributes: IssueAttributes(
                    title: "Native application crash",
                    level: .critical,
                    nativeStackFrames: [frame],
                ),
            )
        }
    }

    @Test("retained native frames produce byte-identical retry events")
    func retainedFramesHaveStableRetryBody() throws {
        let report = makeKSCrashReport(
            threads: [crashedThread(addresses: [0xE00A])],
            images: [
                binaryImage(
                    start: 0xE000,
                    size: 0x100,
                    uuid: "CCCCCCCC-DDDD-EEEE-FFFF-111111111111",
                    cpuType: 0x0100_000C,
                    cpuSubtype: 0,
                ),
            ],
        )
        let store = FakeCrashReportStore(reports: [1: report])
        let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
        try capture.install()
        var bodies: [String] = []

        for _ in 0 ..< 2 {
            _ = try capture.replayPendingReports { record in
                guard let client = try? makeNativeFrameClient() else {
                    return false
                }
                try? record.enqueue(in: client)
                if let body = try? client.previewJSON() {
                    bodies.append(body)
                }
                return false
            }
        }

        #expect(bodies.count == 2)
        #expect(bodies[0] == bodies[1])
        #expect(bodies[0].contains(#""nativeStackFrames""#))
        #expect(store.reportIDs == [1])
    }
}
