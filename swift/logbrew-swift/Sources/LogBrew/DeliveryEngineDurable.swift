import Foundation

extension DeliveryEngine {
    func enableDurableDelivery(options: DurableDeliveryOptions) throws {
        storageLock.lock()
        defer { storageLock.unlock() }
        let memoryQueue = try prepareDurableEnable()

        do {
            let store = try DurableDeliveryStore(parent: options.directory, sdk: sdk)
            let recovered = try recoverDurableState(store: store, memoryQueue: memoryQueue)
            installDurableState(recovered, store: store, parent: options.directory)
        } catch let failure as DurableStoreFailure {
            recordDurableEnableFailure(failure, parent: options.directory)
            throw storageError(failure)
        } catch {
            throw storageError(error)
        }
    }

    func purgeDurableDelivery() throws {
        storageLock.lock()
        defer { storageLock.unlock() }
        let parent = try prepareDurablePurge()
        guard let parent else {
            return
        }

        do {
            try DurableDeliveryStore.purge(parent: parent)
        } catch {
            recordStorageFailure()
            throw storageError(error)
        }
        finishDurablePurge()
    }

    private func prepareDurableEnable() throws -> [QueuedEvent] {
        stateLock.lock()
        defer { stateLock.unlock() }
        if closed || state == .closed || state == .shuttingDown {
            throw SdkError(code: "shutdown_error", message: "client is already shut down")
        }
        if durableStore != nil {
            throw SdkError(code: "configuration_error", message: "durable delivery is already enabled")
        }
        if automaticTransport != nil || inFlight {
            throw SdkError(code: "configuration_error", message: "stop active delivery before enabling durability")
        }
        return queue
    }

    private func recoverDurableState(
        store: DurableDeliveryStore,
        memoryQueue: [QueuedEvent],
    ) throws -> (queue: [QueuedEvent], prefix: FrozenPrefix?) {
        let recovery = store.recovery()
        if recovery.events.isEmpty {
            let names = try store.appendExisting(memoryQueue.map { ($0.event, $0.encodedBytes) })
            let queue = zip(memoryQueue, names).map { item, name in
                QueuedEvent(event: item.event, encodedBytes: item.encodedBytes, durableRecordName: name)
            }
            return (queue, nil)
        }
        guard memoryQueue.isEmpty else {
            throw DurableStoreFailure.owned
        }
        let queue = recovery.events.map {
            QueuedEvent(event: $0.event, encodedBytes: $0.encodedBytes, durableRecordName: $0.recordName)
        }
        return try (queue, recoveredFrozenPrefix(recovery.prefix, queue: queue))
    }

    private func recoveredFrozenPrefix(
        _ recovered: DurableDeliveryStore.RecoveredPrefix?,
        queue: [QueuedEvent],
    ) throws -> FrozenPrefix? {
        guard let recovered else {
            return nil
        }
        let count = recovered.eventRecordNames.count
        let body = try encodeBatch(Array(queue.prefix(count)).map(\.event))
        guard body == recovered.body else {
            throw DurableStoreFailure.corrupt
        }
        return FrozenPrefix(
            count: count,
            bytes: recovered.encodedBytes,
            body: recovered.body,
            durableRecordNames: recovered.eventRecordNames,
        )
    }

    private func installDurableState(
        _ recovered: (queue: [QueuedEvent], prefix: FrozenPrefix?),
        store: DurableDeliveryStore,
        parent: URL,
    ) {
        stateLock.lock()
        queue = recovered.queue
        queuedBytes = recovered.queue.reduce(0) { $0 + $1.encodedBytes }
        frozenPrefix = recovered.prefix
        durableStore = store
        durableParent = parent
        if state == .paused, pauseReason == .storage {
            state = .manual
            pauseReason = .none
        }
        stateLock.unlock()
    }

    private func recordDurableEnableFailure(_ failure: DurableStoreFailure, parent: URL) {
        stateLock.lock()
        durableParent = parent
        if failure == .corrupt {
            state = .paused
            pauseReason = .storage
            lastOutcome = .terminalFailure
            consecutiveFailures += 1
        }
        stateLock.unlock()
    }

    private func prepareDurablePurge() throws -> URL? {
        stateLock.lock()
        defer { stateLock.unlock() }
        if automaticTransport != nil || inFlight || state == .shuttingDown || state == .closed {
            throw SdkError(code: "configuration_error", message: "stop active delivery before purging durable data")
        }
        durableStore = nil
        return durableParent
    }

    private func finishDurablePurge() {
        stateLock.lock()
        queue.removeAll()
        queuedBytes = 0
        frozenPrefix = nil
        durableParent = nil
        state = .manual
        pauseReason = .none
        inFlight = false
        stateLock.unlock()
    }
}
