import Foundation

extension NativeCrashCapture {
    func beginReplay() throws {
        lock.lock()
        defer { lock.unlock() }
        try verifyProcessLocked()
        guard store != nil, lifecycle != .stopped else {
            throw NativeCrashError(.notInstalled)
        }
        guard !replaying else {
            throw NativeCrashError(.replayBusy)
        }
        replaying = true
        lifecycle = .replaying
    }

    func performReplay(_ handler: (NativeCrashRecord) -> Bool) throws -> NativeCrashReplayResult {
        var attempted = 0
        var accepted = 0
        var discardedDuringReplay = 0
        replayLoop: while true {
            switch try nextReplayItem() {
            case .none:
                break replayLoop
            case .discarded:
                discardedDuringReplay += 1
            case let .record(record):
                attempted += 1
                guard handler(record) else {
                    recordRetained()
                    break replayLoop
                }
                try acknowledge(record)
                accepted += 1
            }
        }

        return try NativeCrashReplayResult(
            attempted: attempted,
            acknowledged: accepted,
            discarded: discardedDuringReplay,
            pending: finishReplay(),
        )
    }

    func nextReplayItem() throws -> NativeCrashReplayItem {
        lock.lock()
        defer { lock.unlock() }
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        let reportIDs = try validatedReportIDs(in: store)
        let hangItem = try nextHangReplayItem()
        let engineItem = try nextEngineReplayItem(
            reportIDs: reportIDs,
            store: store,
        )
        if hangItem?.isDiscarded == true || engineItem?.isDiscarded == true {
            return .discarded
        }
        return oldestRecord(in: [hangItem, engineItem])
    }

    func acknowledge(_ record: NativeCrashRecord) throws {
        lock.lock()
        defer { lock.unlock() }
        guard record.ownerNonce == ownerNonce, let store else {
            throw NativeCrashError(.reportChanged)
        }
        try verifyStorageLocked()
        switch record.source {
        case let .engine(reportID):
            try acknowledgeEngineRecord(record, reportID: reportID, store: store)
        case let .hang(eventID):
            try acknowledgeHangRecord(record, eventID: eventID)
        }
        acknowledged += 1
        lastOutcome = .acknowledged
    }

    func pendingReportsLocked() throws -> [NativeCrashRecord] {
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        let reportIDs = try validatedReportIDs(in: store)

        var records: [NativeCrashRecord] = []
        if let incident = try hangStore?.read() {
            try records.append(incident.makeRecord(ownerNonce: ownerNonce))
        }
        try records.append(contentsOf: reportIDs.map { reportID in
            guard let rawReport = store.report(for: reportID) else {
                throw NativeCrashError(.reportChanged)
            }
            return try sanitizer.makeRecord(reportID: reportID, rawReport: rawReport)
        })
        try verifyReportIDs(reportIDs, in: store)
        return records.sorted(by: NativeCrashRecord.occursBefore)
    }

    func pendingCountLocked() throws -> Int {
        guard let store else {
            throw NativeCrashError(.notInstalled)
        }
        try verifyStorageLocked()
        let reportIDs = try validatedReportIDs(in: store)
        return try reportIDs.count + ((hangStore?.read()) == nil ? 0 : 1)
    }

    func failReplay() {
        lock.lock()
        replaying = false
        lifecycle = .installed
        lastOutcome = .failed
        lock.unlock()
    }
}

private extension NativeCrashCapture {
    func nextHangReplayItem() throws -> NativeCrashReplayItem? {
        guard let hangStore else {
            return nil
        }
        do {
            guard let incident = try hangStore.read() else {
                return nil
            }
            return try .record(incident.makeRecord(ownerNonce: ownerNonce))
        } catch let error as NativeCrashError where error.code == .reportCorrupt {
            try hangStore.purge()
            recordDiscardedLocked()
            return .discarded
        }
    }

    func nextEngineReplayItem(
        reportIDs: [Int64],
        store: any CrashReportStoring,
    ) throws -> NativeCrashReplayItem? {
        var records: [NativeCrashRecord] = []
        for reportID in reportIDs {
            let item = try engineReplayItem(
                reportID: reportID,
                expectedReportIDs: reportIDs,
                store: store,
            )
            switch item {
            case .none:
                continue
            case .discarded:
                return .discarded
            case let .record(record):
                records.append(record)
            }
        }
        return records.min(by: NativeCrashRecord.occursBefore).map(NativeCrashReplayItem.record)
    }

    func oldestRecord(in items: [NativeCrashReplayItem?]) -> NativeCrashReplayItem {
        let records = items.compactMap { item -> NativeCrashRecord? in
            guard case let .record(record) = item else {
                return nil
            }
            return record
        }
        return records.min(by: NativeCrashRecord.occursBefore).map(NativeCrashReplayItem.record)
            ?? .none
    }

    func engineReplayItem(
        reportID: Int64,
        expectedReportIDs: [Int64],
        store: any CrashReportStoring,
    ) throws -> NativeCrashReplayItem {
        guard let rawReport = store.report(for: reportID) else {
            throw NativeCrashError(.reportChanged)
        }
        do {
            let record = try sanitizer.makeRecord(reportID: reportID, rawReport: rawReport)
            try verifyReportIDs(expectedReportIDs, in: store)
            return .record(record)
        } catch let error as NativeCrashError where error.code == .reportCorrupt {
            try verifyReportIDs(expectedReportIDs, in: store)
            store.deleteReport(with: reportID)
            guard !store.reportIDs.contains(reportID) else {
                throw NativeCrashError(.reportDeletionFailed)
            }
            recordDiscardedLocked()
            return .discarded
        }
    }

    func validatedReportIDs(in store: any CrashReportStoring) throws -> [Int64] {
        let reportIDs = store.reportIDs.sorted()
        guard reportIDs.count <= configuration.maxStoredReports,
              Set(reportIDs).count == reportIDs.count,
              reportIDs.allSatisfy({ $0 > 0 })
        else {
            throw NativeCrashError(.reportCorrupt)
        }
        return reportIDs
    }

    func verifyReportIDs(
        _ expectedReportIDs: [Int64],
        in store: any CrashReportStoring,
    ) throws {
        guard store.reportIDs.sorted() == expectedReportIDs else {
            throw NativeCrashError(.reportChanged)
        }
    }

    func acknowledgeEngineRecord(
        _ record: NativeCrashRecord,
        reportID: Int64,
        store: any CrashReportStoring,
    ) throws {
        guard store.reportIDs.contains(reportID),
              let rawReport = store.report(for: reportID),
              try sanitizer.digest(rawReport) == record.digest
        else {
            throw NativeCrashError(.reportChanged)
        }
        store.deleteReport(with: reportID)
        guard !store.reportIDs.contains(reportID) else {
            throw NativeCrashError(.reportDeletionFailed)
        }
    }

    func acknowledgeHangRecord(
        _ record: NativeCrashRecord,
        eventID: String,
    ) throws {
        guard let hangStore,
              let incident = try hangStore.read(),
              incident.eventID == eventID,
              try incident.digest() == record.digest
        else {
            throw NativeCrashError(.reportChanged)
        }
        try hangStore.delete(eventID: eventID)
    }

    func recordDiscardedLocked() {
        if discarded < Int.max {
            discarded += 1
        }
        lastOutcome = .discarded
    }

    func recordRetained() {
        lock.lock()
        lastOutcome = .retained
        lock.unlock()
    }

    func finishReplay() throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        let pending = try pendingCountLocked()
        replaying = false
        lifecycle = .installed
        return pending
    }

    var sanitizer: CrashReportSanitizer {
        CrashReportSanitizer(
            maxReplayBytes: configuration.maxReplayBytes,
            ownerNonce: ownerNonce,
        )
    }
}

enum NativeCrashReplayItem {
    case none
    case discarded
    case record(NativeCrashRecord)

    var isDiscarded: Bool {
        if case .discarded = self {
            return true
        }
        return false
    }
}

private extension NativeCrashRecord {
    static func occursBefore(_ lhs: NativeCrashRecord, _ rhs: NativeCrashRecord) -> Bool {
        let lhsTimestamp = NativeCrashTimestamp(lhs.timestamp)
        let rhsTimestamp = NativeCrashTimestamp(rhs.timestamp)
        guard let lhsTimestamp, let rhsTimestamp else {
            return lhs.source.occursBefore(rhs.source)
        }
        if lhsTimestamp != rhsTimestamp {
            return lhsTimestamp < rhsTimestamp
        }
        return lhs.source.occursBefore(rhs.source)
    }
}

private extension NativeCrashRecordSource {
    func occursBefore(_ other: NativeCrashRecordSource) -> Bool {
        switch (self, other) {
        case let (.engine(lhsReportID), .engine(rhsReportID)):
            lhsReportID < rhsReportID
        case (.engine, .hang):
            true
        case (.hang, .engine), (.hang, .hang):
            false
        }
    }
}
