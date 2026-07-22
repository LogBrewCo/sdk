import Foundation
import LogBrew
@testable import LogBrewCrash
import Testing

func expectedNativeStackFrames() -> [[String: Any]] {
    [
        [
            "imageUuid": "11111111-2222-3333-4444-555555555555",
            "architecture": "arm64",
            "instructionOffset": "0000000000000010",
        ],
        [
            "imageUuid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            "architecture": "arm64e",
            "instructionOffset": "000000000000002f",
        ],
        [
            "imageUuid": "01234567-89ab-cdef-0123-456789abcdef",
            "architecture": "x86_64",
            "instructionOffset": "0000000000000000",
        ],
    ]
}

func issueAttributes(for report: [String: Any]) throws -> [String: Any] {
    let data = try #require(eventJSON(for: report).data(using: .utf8))
    let payload = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
    let events = try #require(payload["events"] as? [[String: Any]])
    let event = try #require(events.first)
    return try #require(event["attributes"] as? [String: Any])
}

func eventJSON(for report: [String: Any]) throws -> String {
    let store = FakeCrashReportStore(reports: [1: report])
    let capture = try makeCapture(driver: FakeCrashEngineDriver(store: store))
    try capture.install()
    let record = try #require(capture.pendingReports().first)
    let client = try makeNativeFrameClient()
    try record.enqueue(in: client)
    return try client.previewJSON()
}

func makeNativeFrameClient() throws -> LogBrewClient {
    try LogBrewClient.create(
        apiKey: "LOGBREW_API_KEY",
        sdkName: "native-frame-test",
        sdkVersion: "0.1.0",
    )
}

func makeKSCrashReport(
    threads: [[String: Any]],
    images: [[String: Any]],
) -> [String: Any] {
    [
        "report": [
            "id": "8F12B746-0C79-4CC6-A077-98ED62F094B2",
            "timestamp": "2026-07-17T09:10:11Z",
        ],
        "crash": [
            "error": ["type": "signal", "reason": "private-report-value"],
            "threads": threads,
        ],
        "binary_images": images,
        "system": ["process_name": "private-report-value"],
        "user": ["opaque_value": "private-report-value"],
    ]
}

func crashedThread(addresses: [Any]) -> [String: Any] {
    [
        "crashed": true,
        "name": "private-thread-name",
        "registers": ["basic": ["pc": 0x1010]],
        "backtrace": [
            "contents": addresses.map { address in
                [
                    "instruction_addr": address,
                    "symbol_name": "private_symbol_name",
                ]
            },
        ],
    ]
}

func binaryImage(
    start: Any,
    size: Any,
    uuid: String,
    cpuType: Any,
    cpuSubtype: Any,
) -> [String: Any] {
    [
        "image_addr": start,
        "image_size": size,
        "uuid": uuid,
        "cpu_type": cpuType,
        "cpu_subtype": cpuSubtype,
        "name": "/Applications/Private.app/Private",
    ]
}
