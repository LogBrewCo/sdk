import CoreFoundation
import Foundation
@_spi(CrashReplay) import LogBrew

struct NativeStackFrameSanitizer {
    private static let maxFrames = 32
    private static let cpuTypeArm64: Int32 = 0x0100_000C
    private static let cpuTypeX8664: Int32 = 0x0100_0007
    private static let cpuSubtypeMask: UInt32 = 0x00FF_FFFF

    func frames(from rawReport: [String: Any]) -> [NativeStackFrame]? {
        guard let crash = rawReport["crash"] as? [String: Any],
              let threads = crash["threads"] as? [Any]
        else {
            return nil
        }
        let crashedThreads = threads.compactMap { value -> [String: Any]? in
            guard let thread = value as? [String: Any], strictBool(thread["crashed"]) == true else {
                return nil
            }
            return thread
        }
        guard crashedThreads.count == 1,
              let backtrace = crashedThreads[0]["backtrace"] as? [String: Any],
              let rawFrames = backtrace["contents"] as? [Any],
              let rawImages = rawReport["binary_images"] as? [Any]
        else {
            return nil
        }

        let images = rawImages.compactMap(parseImage)
        guard identitiesAreUnique(images) else {
            return nil
        }

        var result: [NativeStackFrame] = []
        result.reserveCapacity(min(rawFrames.count, Self.maxFrames))
        for rawFrame in rawFrames {
            guard let frame = rawFrame as? [String: Any],
                  let instructionAddress = unsignedInteger(frame["instruction_addr"])
            else {
                continue
            }
            let matchingImages = images.filter { $0.contains(instructionAddress) }
            guard matchingImages.count <= 1 else {
                return nil
            }
            guard let image = matchingImages.first else {
                continue
            }
            guard result.count < Self.maxFrames else {
                continue
            }
            result.append(
                NativeStackFrame(
                    imageUuid: image.uuid,
                    architecture: image.architecture,
                    instructionOffset: String(format: "%016llx", instructionAddress - image.start),
                ),
            )
        }
        return result.isEmpty ? nil : result
    }

    private func parseImage(_ value: Any) -> BinaryImage? {
        guard let image = value as? [String: Any],
              let start = unsignedInteger(image["image_addr"]),
              let size = unsignedInteger(image["image_size"]),
              size > 0,
              let rawUUID = image["uuid"] as? String,
              let uuid = UUID(uuidString: rawUUID)?.uuidString.lowercased(),
              let cpuType = signedInt32(image["cpu_type"]),
              let cpuSubtype = signedInt32(image["cpu_subtype"]),
              let architecture = architecture(cpuType: cpuType, cpuSubtype: cpuSubtype)
        else {
            return nil
        }
        let (end, overflow) = start.addingReportingOverflow(size)
        guard !overflow else {
            return nil
        }
        return BinaryImage(start: start, end: end, uuid: uuid, architecture: architecture)
    }

    private func identitiesAreUnique(_ images: [BinaryImage]) -> Bool {
        var identities: Set<ImageIdentity> = []
        for image in images where !identities.insert(image.identity).inserted {
            return false
        }
        return true
    }

    private func architecture(cpuType: Int32, cpuSubtype: Int32) -> NativeStackArchitecture? {
        let subtype = UInt32(bitPattern: cpuSubtype) & Self.cpuSubtypeMask
        switch (cpuType, subtype) {
        case (Self.cpuTypeArm64, 0), (Self.cpuTypeArm64, 1):
            return .arm64
        case (Self.cpuTypeArm64, 2):
            return .arm64e
        case (Self.cpuTypeX8664, 3):
            return .x8664
        default:
            return nil
        }
    }

    private func strictBool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) == CFBooleanGetTypeID()
        else {
            return nil
        }
        return number.boolValue
    }

    private func unsignedInteger(_ value: Any?) -> UInt64? {
        guard let number = integralNumber(value) else {
            return nil
        }
        switch String(cString: number.objCType) {
        case "C", "S", "I", "L", "Q":
            return number.uint64Value
        default:
            let signed = number.int64Value
            return signed < 0 ? nil : UInt64(signed)
        }
    }

    private func signedInt32(_ value: Any?) -> Int32? {
        guard let number = integralNumber(value) else {
            return nil
        }
        return Int32(exactly: number.int64Value)
    }

    private func integralNumber(_ value: Any?) -> NSNumber? {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID()
        else {
            return nil
        }
        switch String(cString: number.objCType) {
        case "c", "C", "s", "S", "i", "I", "l", "L", "q", "Q":
            return number
        default:
            return nil
        }
    }
}

private struct BinaryImage {
    let start: UInt64
    let end: UInt64
    let uuid: String
    let architecture: NativeStackArchitecture

    var identity: ImageIdentity {
        ImageIdentity(uuid: uuid, architecture: architecture)
    }

    func contains(_ address: UInt64) -> Bool {
        address >= start && address < end
    }
}

private struct ImageIdentity: Hashable {
    let uuid: String
    let architecture: NativeStackArchitecture
}
