import Foundation

@objc(LBRNAppleNativeDiagnostics)
public final class LBRNAppleNativeDiagnostics: NSObject, @unchecked Sendable {
    private static let shared = LBRNAppleNativeDiagnostics()
    private static let sdkVersion = "0.1.30"

    private let lock = NSLock()
    private let replayQueue = DispatchQueue(label: "co.logbrew.react-native.apple-diagnostics-replay")
    private var capture: NativeCrashCapture?
    private var client: LogBrewClient?
    private var transport: HTTPTransport?
    private var installedConfiguration: InstalledConfiguration?

    @objc(installWithConfiguration:)
    public static func install(with configuration: NSDictionary) -> NSDictionary {
        if Thread.isMainThread {
            return shared.installOnMainThread(configuration)
        }
        var result: NSDictionary = ["status": "native_diagnostics_failed"]
        DispatchQueue.main.sync {
            result = shared.installOnMainThread(configuration)
        }
        return result
    }

    @objc(replayWithCompletion:)
    public static func replay(withCompletion completion: @escaping (NSDictionary) -> Void) {
        shared.replayQueue.async {
            let result = shared.replayPendingReports()
            DispatchQueue.main.async {
                completion(result)
            }
        }
    }

    @objc(status)
    public static func status() -> NSDictionary {
        shared.currentStatus()
    }

    @objc(setCorrelationContext:)
    public static func setCorrelationContext(_ rawContext: NSDictionary?) -> NSDictionary {
        shared.updateCorrelationContext(rawContext)
    }

    @objc(setBreadcrumbs:)
    public static func setBreadcrumbs(_ rawSnapshot: NSDictionary?) -> NSDictionary {
        shared.updateBreadcrumbs(rawSnapshot)
    }

    private func installOnMainThread(_ rawConfiguration: NSDictionary) -> NSDictionary {
        guard let configuration = InstalledConfiguration(rawConfiguration) else {
            return failure("native_diagnostics_invalid_configuration")
        }

        lock.lock()
        defer { lock.unlock() }

        if let installedConfiguration {
            guard installedConfiguration == configuration else {
                return failure("native_diagnostics_already_installed")
            }
            return captureStatus(status: "already_installed")
        }

        do {
            let storageDirectory = try Self.prepareStorageDirectory(
                projectId: configuration.projectId,
            )
            let identity = try NativeArtifactIdentity(
                projectId: configuration.projectId,
                release: configuration.release,
                environment: configuration.environment,
                service: configuration.service,
            )
            let watchdog = try configuration.hangThresholdSeconds.map {
                try NativeHangWatchdogConfiguration(threshold: $0)
            }
            let nativeConfiguration = try NativeCrashConfiguration(
                storageDirectory: storageDirectory,
                artifactIdentity: identity,
                hangWatchdog: watchdog,
            )
            let capture = NativeCrashCapture(configuration: nativeConfiguration)
            let client = try LogBrewClient.create(
                apiKey: configuration.apiKey,
                sdkName: "logbrew-react-native-apple",
                sdkVersion: Self.sdkVersion,
            )
            let transport = try HTTPTransport(endpoint: configuration.endpoint)

            try capture.install()
            self.capture = capture
            self.client = client
            self.transport = transport
            installedConfiguration = configuration
            return captureStatus(status: "installed")
        } catch let error as NativeCrashError {
            return failure(error.code.rawValue)
        } catch {
            return failure("native_diagnostics_failed")
        }
    }

    private func replayPendingReports() -> NSDictionary {
        lock.lock()
        guard let capture, let client, let transport else {
            lock.unlock()
            return failure("native_diagnostics_not_installed")
        }
        lock.unlock()

        do {
            let result = try capture.replayPendingReports(in: client, transport: transport)
            return [
                "acknowledged": result.acknowledged,
                "attempted": result.attempted,
                "discarded": result.discarded,
                "pending": result.pending,
                "status": "replayed",
            ]
        } catch let error as NativeCrashError {
            return failure(error.code.rawValue)
        } catch {
            return failure("native_diagnostics_failed")
        }
    }

    private func currentStatus() -> NSDictionary {
        lock.lock()
        defer { lock.unlock() }
        guard capture != nil else {
            return [
                "acknowledged": 0,
                "discarded": 0,
                "lifecycle": "idle",
                "pending": 0,
                "status": "not_installed",
            ]
        }
        return captureStatus(status: "ready")
    }

    private func updateCorrelationContext(_ rawContext: NSDictionary?) -> NSDictionary {
        lock.lock()
        defer { lock.unlock() }
        guard let capture else {
            return failure("native_diagnostics_not_installed")
        }
        do {
            let snapshot = try rawContext.map { try NativeCrashCorrelation.validated($0) }
            try capture.setDiagnosticContext(
                context: snapshot?.correlationContext,
                impact: snapshot?.impact,
            )
            return ["status": rawContext == nil ? "cleared" : "updated"]
        } catch let error as NativeCrashError {
            return failure(error.code.rawValue)
        } catch {
            return failure("native_diagnostics_failed")
        }
    }

    private func updateBreadcrumbs(_ rawSnapshot: NSDictionary?) -> NSDictionary {
        lock.lock()
        defer { lock.unlock() }
        guard let capture else {
            return failure("native_diagnostics_not_installed")
        }
        do {
            let snapshot = try rawSnapshot.map { try NativeCrashBreadcrumbs.validated($0) }
            try capture.setBreadcrumbs(
                snapshot?.breadcrumbs,
                truncated: snapshot?.truncated ?? false,
            )
            return ["status": rawSnapshot == nil ? "cleared" : "updated"]
        } catch let error as NativeCrashError {
            return failure(error.code.rawValue)
        } catch {
            return failure("native_diagnostics_failed")
        }
    }

    private func captureStatus(status: String) -> NSDictionary {
        guard let capture else {
            return failure("native_diagnostics_not_installed")
        }
        do {
            let value = try capture.status()
            return [
                "acknowledged": value.acknowledged,
                "discarded": value.discarded,
                "lifecycle": value.lifecycle.logBrewName,
                "pending": value.pending,
                "status": status,
            ]
        } catch let error as NativeCrashError {
            return failure(error.code.rawValue)
        } catch {
            return failure("native_diagnostics_failed")
        }
    }

    private func failure(_ code: String) -> NSDictionary {
        ["code": code, "status": "error"]
    }

    private static func prepareStorageDirectory(projectId: String) throws -> URL {
        let fileManager = FileManager.default
        guard let applicationSupport = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
        ).first else {
            throw NativeCrashError(.storageUnsupported)
        }
        do {
            try fileManager.createDirectory(
                at: applicationSupport,
                withIntermediateDirectories: true,
                attributes: nil,
            )
        } catch {
            throw NativeCrashError(.storageUnsupported)
        }
        return applicationSupport.appendingPathComponent(
            "LogBrewAppleDiagnostics-\(projectId)",
            isDirectory: true,
        )
    }
}

private struct InstalledConfiguration: Equatable {
    private static let allowedKeys = Set([
        "apiKey",
        "endpoint",
        "environment",
        "fatalHandlerOwnership",
        "hangThresholdSeconds",
        "projectId",
        "release",
        "service",
    ])

    let apiKey: String
    let endpoint: URL
    let environment: String
    let hangThresholdSeconds: TimeInterval?
    let projectId: String
    let release: String
    let service: String

    init?(_ values: NSDictionary) {
        let keys = Set(values.allKeys.compactMap { $0 as? String })
        guard keys.count == values.count,
              keys.isSubset(of: Self.allowedKeys),
              values["fatalHandlerOwnership"] as? String == "logbrew",
              let apiKey = Self.exactString(values["apiKey"], maxBytes: 4096),
              let projectId = Self.exactString(values["projectId"], maxBytes: 64),
              let release = Self.exactString(values["release"]),
              let environment = Self.exactString(values["environment"]),
              let service = Self.exactString(values["service"])
        else {
            return nil
        }

        let endpoint: URL
        if let endpointValue = values["endpoint"] {
            guard let parsedEndpoint = Self.exactDeliveryEndpoint(endpointValue)
            else {
                return nil
            }
            endpoint = parsedEndpoint
        } else {
            endpoint = HTTPTransport.defaultEndpoint
        }

        let hangThresholdSeconds: TimeInterval?
        if let thresholdValue = values["hangThresholdSeconds"] {
            guard let number = thresholdValue as? NSNumber,
                  CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite,
                  (1 ... 30).contains(number.doubleValue)
            else {
                return nil
            }
            hangThresholdSeconds = number.doubleValue
        } else {
            hangThresholdSeconds = nil
        }

        self.apiKey = apiKey
        self.endpoint = endpoint
        self.environment = environment
        self.hangThresholdSeconds = hangThresholdSeconds
        self.projectId = projectId
        self.release = release
        self.service = service
    }

    private static func exactString(_ value: Any?, maxBytes: Int = 256) -> String? {
        guard let value = value as? String,
              (1 ... maxBytes).contains(value.utf8.count),
              value == value.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains)
        else {
            return nil
        }
        return value
    }

    private static func exactDeliveryEndpoint(_ value: Any?) -> URL? {
        guard let endpoint = exactString(value, maxBytes: 2_048),
              let components = URLComponents(string: endpoint),
              components.scheme == "https",
              components.host?.isEmpty == false,
              components.path.starts(with: "/"),
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil,
              let url = components.url,
              url.absoluteString == endpoint,
              url.standardized.absoluteString == endpoint
        else {
            return nil
        }
        return url
    }
}

private extension NativeCrashLifecycleState {
    var logBrewName: String {
        switch self {
        case .idle: "idle"
        case .installed: "installed"
        case .replaying: "replaying"
        case .failed: "failed"
        case .stopped: "stopped"
        @unknown default: "unknown"
        }
    }
}
