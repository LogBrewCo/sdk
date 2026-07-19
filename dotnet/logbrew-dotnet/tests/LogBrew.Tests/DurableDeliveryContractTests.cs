using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using LogBrew;

internal static partial class DurableDeliveryContractTests
{
    private const string ApiKey = "LOGBREW_API_KEY";

    internal static int Run()
    {
        ManualDefaultsRemainUnchanged();
        DurableAutomaticDeliveryIsExplicit();
        DurableOptionsCopyCallerKeys();
        SupportedPlatformPairsAreExplicit();
        UnsupportedPlatformPairsFailClosed();
        UnixNativeLibraryCandidatesAreExplicit();
        UnixNativeExportsAreExplicit();
        UnsupportedUnixNativeLibraryCandidatesFailClosed();
        UnixNativeInitializationIsConcurrentAndStable();
        UnixOpenImportsMatchVariadicArity();
        LinuxOpenFlagsMatchArchitectureAbi();
        WindowsFileInformationMatchesNativeAbi();
        WindowsPublishedRecordValidationSharesActiveWriter();
        WindowsDeletionIsHandleBoundAndFailsClosed();
        MacOSX64StoreIdentityUsesModernInodeAbi();
        SafeHandleIdentityRecognizesRegularFiles();
        ChildSymlinkFailsClosed();
        BroadChildFailsBeforeMutation();
        OwnerSymlinkFailsClosed();
        OwnerHardLinkFailsClosed();
        BroadExistingStoreEntriesFailWithoutMutation();
        PrivateExistingOwnerRemainsUnchanged();
        ConcurrentOwnerFailsClosed();
        ParentReplacementPausesBeforeAdmission();
        ChildReplacementPausesBeforeAdmission();
        OwnerReplacementPausesBeforeAdmission();
        FailedAdmissionReportsContentFreeDrop();
        StorageDropCallbackRunsOutsideOwnership();
        ShutdownWaitsForDurableAdmissionCommit();
        KeyOwnersZeroTheirBuffers();
        FactoryFailureZeroesTransferredKeys();
        DurableAdmissionWritesOnlyEncryptedContent();
        DurableSpanArraysAreAccepted();
        PersistedAdmissionSurvivesPreCommitExit();
        DurableRestartRecoversOldestFirst();
        FrozenPrefixPersistsBeforeSendAndRetriesIdentically();
        AcknowledgedPrefixCleanupResumesAfterExit();
        LocalAcknowledgementFailureRetainsExactPrefix();
        KeyRotationSurvivesRecordReplacementExit();
        RecoveryAdmissionIsBoundedBeforeRotation();
        return 40;
    }

    internal static int RunChild(string[] arguments)
    {
        if (arguments.Length != 2)
        {
            return 2;
        }

        if (arguments[0] == "--durable-child-write")
        {
            var client = CreateDurableClient(arguments[1]);
            client.Log("evt_restart_1", "2026-06-02T10:00:03Z", LogAttributes.Create("first", "info"));
            client.Log("evt_restart_2", "2026-06-02T10:00:04Z", LogAttributes.Create("second", "info"));
            client.Span("evt_restart_span", "2026-06-02T10:00:05Z", SpanWithArrays());
            Environment.Exit(0);
        }

        if (arguments[0] == "--durable-child-freeze")
        {
            using var key = new DurableDeliveryKey("primary-2026", Enumerable.Repeat((byte)0x31, 32).ToArray());
            using var storage = new DurableDeliveryOptions(arguments[1], key);
            var client = LogBrewClient.CreateAutomaticDurable(
                ApiKey,
                "logbrew-dotnet",
                "0.1.0",
                new ExitOnSendTransport(System.IO.Path.Combine(arguments[1], "expected-body.txt")),
                storage,
                new AutomaticDeliveryOptions
                {
                    FlushAtQueueSize = 1,
                    FlushInterval = TimeSpan.FromHours(1),
                });
            client.Log("evt_frozen_restart", "2026-06-02T10:00:03Z", LogAttributes.Create("frozen", "info"));
            Thread.Sleep(TimeSpan.FromSeconds(5));
            return 3;
        }

        if (arguments[0] == "--durable-child-admission-checkpoint")
        {
            SetStoreCheckpoint(name =>
            {
                if (name == "event_persisted")
                {
                    Environment.Exit(0);
                }
            });
            var client = CreateDurableClient(arguments[1]);
            client.Log("evt_admission_checkpoint", "2026-06-02T10:00:03Z", LogAttributes.Create("admitted", "info"));
            return 3;
        }

        if (arguments[0] == "--durable-child-ack-checkpoint")
        {
            SetStoreCheckpoint(name =>
            {
                if (name == "acknowledgement_persisted")
                {
                    Environment.Exit(0);
                }
            });
            var client = CreateDurableClient(arguments[1]);
            client.Log("evt_ack_checkpoint", "2026-06-02T10:00:03Z", LogAttributes.Create("acknowledged", "info"));
            client.Flush();
            return 3;
        }

        if (arguments[0] == "--durable-child-write-old-key")
        {
            var client = CreateDurableClientWithKeys(arguments[1], "old-key", 0x21);
            client.Log("evt_rotation_1", "2026-06-02T10:00:03Z", LogAttributes.Create("rotation first", "info"));
            client.Log("evt_rotation_2", "2026-06-02T10:00:04Z", LogAttributes.Create("rotation second", "info"));
            Environment.Exit(0);
        }

        if (arguments[0] == "--durable-child-rotation-checkpoint")
        {
            SetStoreCheckpoint(name =>
            {
                if (name == "rotation_record_persisted")
                {
                    Environment.Exit(0);
                }
            });
            CreateDurableClientWithKeys(arguments[1], "new-key", 0x31, "old-key", 0x21);
            return 3;
        }

        if (arguments[0] == "--durable-child-rotation-complete")
        {
            using var primary = new DurableDeliveryKey("new-key", Enumerable.Repeat((byte)0x31, 32).ToArray());
            using var previous = new DurableDeliveryKey("old-key", Enumerable.Repeat((byte)0x21, 32).ToArray());
            using var options = new DurableDeliveryOptions(arguments[1], primary, new[] { previous });
            var previousBuffer = GetOptionKeyBuffer(options, "old-key");
            LogBrewClient.CreateAutomaticDurable(
                ApiKey,
                "logbrew-dotnet",
                "0.1.0",
                RecordingTransport.AlwaysAccept(),
                options,
                new AutomaticDeliveryOptions
                {
                    FlushAtQueueSize = 100,
                    FlushInterval = TimeSpan.FromHours(1),
                });
            if (previousBuffer.Any(value => value != 0))
            {
                return 4;
            }

            Environment.Exit(0);
        }

        return 2;
    }

    private static void ManualDefaultsRemainUnchanged()
    {
        var client = LogBrewClient.Create(ApiKey, "logbrew-dotnet", "0.1.0");
        AssertTrue(client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Manual, "manual factory changed lifecycle");
        client.Log("evt_manual_default", "2026-06-02T10:00:03Z", LogAttributes.Create("manual", "info"));
        AssertTrue(client.PendingEvents() == 1, "manual factory stopped queueing locally");
        AssertTrue(client.Shutdown(RecordingTransport.AlwaysAccept()).StatusCode == 202, "manual shutdown changed");
    }

    private static void DurableAutomaticDeliveryIsExplicit()
    {
        using var root = new TemporaryDirectory();
        using var key = new DurableDeliveryKey("primary-2026", Enumerable.Repeat((byte)0x31, 32).ToArray());
        using var storage = new DurableDeliveryOptions(root.Path, key);
        var transport = RecordingTransport.AlwaysAccept();
        var client = LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            transport,
            storage,
            new AutomaticDeliveryOptions
            {
                FlushAtQueueSize = 100,
                FlushInterval = TimeSpan.FromHours(1),
            });

        AssertTrue(client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Running, "durable automatic factory did not own delivery");
        AssertTrue(client.Shutdown().StatusCode == 204, "empty durable shutdown changed");
    }

    private static void DurableOptionsCopyCallerKeys()
    {
        using var root = new TemporaryDirectory();
        var primaryBytes = Enumerable.Repeat((byte)0x42, 32).ToArray();
        var previousBytes = Enumerable.Repeat((byte)0x24, 32).ToArray();
        using var primary = new DurableDeliveryKey("primary", primaryBytes);
        using var previous = new DurableDeliveryKey("previous", previousBytes);
        using var options = new DurableDeliveryOptions(root.Path, primary, new[] { previous });

        Array.Clear(primaryBytes, 0, primaryBytes.Length);
        Array.Clear(previousBytes, 0, previousBytes.Length);

        AssertTrue(options.PrimaryKeyId == "primary", "primary key identifier changed");
        AssertTrue(options.PreviousKeyIds.Count == 1 && options.PreviousKeyIds[0] == "previous", "previous key identifiers changed");
        AssertTrue(!options.GetType().GetProperties().Any(property => property.Name.Contains("Material", StringComparison.Ordinal)), "public options exposed key material");
    }

    private static void FailedAdmissionReportsContentFreeDrop()
    {
        using var root = new TemporaryDirectory();
        DroppedEvent? dropped = null;
        var callbackCount = 0;
        var client = CreateDurableClient(root.Path, value =>
        {
            callbackCount++;
            dropped = value;
        });
        var owner = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1", ".owner");
        var moved = owner + ".moved";
        File.Move(owner, moved);
        File.WriteAllText(owner, string.Empty);

        client.Log("evt_storage_sensitive", "2026-06-02T10:00:03Z", LogAttributes.Create("payload must stay private", "info"));

        AssertTrue(client.PendingEvents() == 0, "failed admission entered memory");
        AssertTrue(client.DroppedEvents() == 1, "failed admission did not increment drops");
        AssertTrue(callbackCount == 1, "failed admission callback count changed");
        AssertTrue(dropped != null && dropped.Reason == "storage_unavailable", "failed admission reason changed");
        AssertTrue(!dropped!.Reason.Contains(root.Path, StringComparison.Ordinal), "drop reason exposed a path");
        AssertTrue(!dropped.Reason.Contains("payload", StringComparison.Ordinal), "drop reason exposed event content");
        File.Delete(owner);
        File.Move(moved, owner);
        AssertTrue(client.Shutdown().StatusCode == 204, "failed admission shutdown failed");
    }

    private static void StorageDropCallbackRunsOutsideOwnership()
    {
        using var root = new TemporaryDirectory();
        using var callbackEntered = new ManualResetEventSlim(false);
        using var callbackRelease = new ManualResetEventSlim(false);
        var callbackCount = 0;
        var nestedCaptureIssued = 0;
        LogBrewClient? client = null;
        client = CreateDurableClient(root.Path, _ =>
        {
            Interlocked.Increment(ref callbackCount);
            if (Interlocked.CompareExchange(ref nestedCaptureIssued, 1, 0) == 0)
            {
                client!.Log("evt_storage_nested", "2026-06-02T10:00:03Z", LogAttributes.Create("nested", "info"));
                callbackEntered.Set();
                callbackRelease.Wait(TimeSpan.FromSeconds(5));
            }
        });
        var owner = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1", ".owner");
        var moved = owner + ".moved";
        File.Move(owner, moved);
        File.WriteAllText(owner, string.Empty);

        var firstCapture = Task.Run(() => client.Log("evt_storage_outer", "2026-06-02T10:00:03Z", LogAttributes.Create("outer", "info")));
        AssertTrue(callbackEntered.Wait(TimeSpan.FromSeconds(2)), "storage callback did not reach its reentrant capture");
        var concurrentCapture = Task.Run(() => client.Log("evt_storage_concurrent", "2026-06-02T10:00:03Z", LogAttributes.Create("concurrent", "info")));
        var completedOutsideOwnership = concurrentCapture.Wait(TimeSpan.FromSeconds(1));
        callbackRelease.Set();
        AssertTrue(firstCapture.Wait(TimeSpan.FromSeconds(2)), "storage callback did not return");
        AssertTrue(concurrentCapture.Wait(TimeSpan.FromSeconds(2)), "concurrent storage capture did not return");

        AssertTrue(completedOutsideOwnership, "storage callback retained durable ownership");
        AssertTrue(callbackCount == 2, "storage callback reentrancy was not suppressed");
        AssertTrue(client.PendingEvents() == 0, "failed reentrant captures entered memory");
        AssertTrue(client.DroppedEvents() == 3, "failed reentrant capture drop count changed");
        File.Delete(owner);
        File.Move(moved, owner);
        AssertTrue(client.Shutdown().StatusCode == 204, "storage callback shutdown failed");
    }

    private static void ShutdownWaitsForDurableAdmissionCommit()
    {
        using var root = new TemporaryDirectory();
        using var persisted = new ManualResetEventSlim(false);
        using var release = new ManualResetEventSlim(false);
        var hooks = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreTestHooks", throwOnError: true)!;
        var checkpoint = hooks.GetProperty("Checkpoint", BindingFlags.Static | BindingFlags.NonPublic)!;
        checkpoint.SetValue(null, new Action<string>(name =>
        {
            if (name == "event_persisted")
            {
                persisted.Set();
                release.Wait(TimeSpan.FromSeconds(5));
            }
        }));

        try
        {
            var transport = new RecordingTransport(new object[] { 202 });
            var client = CreateDurableClient(root.Path, transport: transport);
            var capture = Task.Run(() => client.Log("evt_persist_shutdown", "2026-06-02T10:00:03Z", LogAttributes.Create("persist race", "info")));
            AssertTrue(persisted.Wait(TimeSpan.FromSeconds(2)), "durable admission did not reach persisted checkpoint");
            var shutdown = Task.Run(client.Shutdown);
            var shutdownPassedReservation = shutdown.Wait(TimeSpan.FromMilliseconds(300));
            release.Set();
            AssertTrue(capture.Wait(TimeSpan.FromSeconds(2)), "durable admission did not commit");
            AssertTrue(shutdown.Wait(TimeSpan.FromSeconds(2)), "shutdown did not finish after durable admission");

            AssertTrue(!shutdownPassedReservation, "shutdown bypassed an unresolved durable admission");
            AssertTrue(transport.SentBodies.Count == 1 && transport.SentBodies[0].Contains("evt_persist_shutdown", StringComparison.Ordinal), "shutdown did not deliver committed admission");
            AssertTrue(client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Closed, "durable shutdown did not stay closed");
        }
        finally
        {
            release.Set();
            checkpoint.SetValue(null, null);
        }
    }

    private static void KeyOwnersZeroTheirBuffers()
    {
        using var root = new TemporaryDirectory();
        var source = Enumerable.Repeat((byte)0x5a, 32).ToArray();
        var key = new DurableDeliveryKey("zero-test", source);
        var keyBuffer = GetPrivateByteArray(key, "keyBytes");
        Array.Clear(source, 0, source.Length);
        AssertTrue(keyBuffer.Any(value => value != 0), "key did not copy caller bytes");
        key.Dispose();
        AssertTrue(keyBuffer.All(value => value == 0), "key disposal did not zero its buffer");

        var optionKey = new DurableDeliveryKey("option-key", Enumerable.Repeat((byte)0x33, 32).ToArray());
        var options = new DurableDeliveryOptions(root.Path, optionKey);
        var optionsBuffer = GetOptionKeyBuffer(options, "option-key");
        optionKey.Dispose();
        options.Dispose();
        AssertTrue(optionsBuffer.All(value => value == 0), "options disposal did not zero its key buffer");
    }

    private static void FactoryFailureZeroesTransferredKeys()
    {
        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        var target = System.IO.Path.Combine(root.Path, "unrelated-key-failure");
        File.WriteAllText(target, "unchanged");
        File.CreateSymbolicLink(System.IO.Path.Combine(child, ".owner"), target);
        using var key = new DurableDeliveryKey("factory-failure", Enumerable.Repeat((byte)0x6b, 32).ToArray());
        using var options = new DurableDeliveryOptions(root.Path, key);
        var transferredBuffer = GetOptionKeyBuffer(options, "factory-failure");

        ExpectStorageFailure(() => LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            RecordingTransport.AlwaysAccept(),
            options));

        AssertTrue(transferredBuffer.All(value => value == 0), "factory failure did not zero transferred key material");
        AssertTrue(File.ReadAllText(target) == "unchanged", "factory failure mutated owner symlink target");
    }

    private static void DurableAdmissionWritesOnlyEncryptedContent()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        const string eventId = "evt_plaintext_sentinel_7f9b";
        const string message = "message_plaintext_sentinel_4c31";
        client.Log(eventId, "2026-06-02T10:00:03Z", LogAttributes.Create(message, "info"));

        var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
        if (!OperatingSystem.IsWindows())
        {
            var ownerMode = File.GetUnixFileMode(System.IO.Path.Combine(child, ".owner"));
            AssertTrue(ownerMode == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "owner permissions are not 0600");
        }

        var records = Directory.GetFiles(child).Where(path => System.IO.Path.GetFileName(path) != ".owner").ToArray();
        AssertTrue(records.Length == 1, "durable admission did not create exactly one event record");
        if (!OperatingSystem.IsWindows())
        {
            var recordMode = File.GetUnixFileMode(records[0]);
            AssertTrue(recordMode == (UnixFileMode.UserRead | UnixFileMode.UserWrite), "event record permissions are not 0600");
        }

        var bytes = File.ReadAllBytes(records[0]);
        var text = System.Text.Encoding.UTF8.GetString(bytes);
        AssertTrue(!text.Contains(eventId, StringComparison.Ordinal), "event id was persisted in plaintext");
        AssertTrue(!text.Contains(message, StringComparison.Ordinal), "event message was persisted in plaintext");
        AssertTrue(!text.Contains(ApiKey, StringComparison.Ordinal), "API key was persisted");
        AssertTrue(!text.Contains(root.Path, StringComparison.Ordinal), "local path was persisted");
        AssertTrue(client.PendingEvents() == 1, "durable admission did not commit memory state");
        AssertTrue(client.Shutdown().StatusCode == 202, "durable admission shutdown failed");
    }

    private static void DurableRestartRecoversOldestFirst()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-write", root.Path);
        var transport = new RecordingTransport(new object[] { 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        AssertTrue(client.PendingEvents() == 3, "restart did not recover the durable queue");
        var response = client.Flush();
        AssertTrue(response.StatusCode == 202, "restart flush status changed");
        AssertTrue(transport.SentBodies.Count == 1, "restart request count changed");
        var body = transport.SentBodies[0];
        AssertTrue(body.IndexOf("evt_restart_1", StringComparison.Ordinal) < body.IndexOf("evt_restart_2", StringComparison.Ordinal), "restart recovery order changed");
        AssertTrue(body.IndexOf("evt_restart_2", StringComparison.Ordinal) < body.IndexOf("evt_restart_span", StringComparison.Ordinal), "restart span order changed");
        AssertTrue(body.Contains("span-event", StringComparison.Ordinal) && body.Contains("traceId", StringComparison.Ordinal), "restart span arrays changed");
        AssertTrue(client.PendingEvents() == 0, "accepted restart prefix remained queued");
        AssertTrue(client.Shutdown().StatusCode == 204, "restarted client shutdown failed");
    }

    private static void PersistedAdmissionSurvivesPreCommitExit()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-admission-checkpoint", root.Path);
        var transport = new RecordingTransport(new object[] { 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        AssertTrue(client.PendingEvents() == 1, "persisted pre-commit admission was lost");
        AssertTrue(client.Flush().StatusCode == 202, "persisted pre-commit admission did not flush");
        AssertTrue(transport.SentBodies.Count == 1 && transport.SentBodies[0].Contains("evt_admission_checkpoint", StringComparison.Ordinal), "persisted pre-commit admission changed");
        AssertTrue(client.Shutdown().StatusCode == 204, "pre-commit recovery shutdown failed");
    }

    private static void FrozenPrefixPersistsBeforeSendAndRetriesIdentically()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-freeze", root.Path);
        var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
        AssertTrue(File.Exists(System.IO.Path.Combine(child, "delivery-state.lbd")), "frozen prefix was not persisted before send");
        var expectedBody = File.ReadAllText(System.IO.Path.Combine(root.Path, "expected-body.txt"));
        var transport = new RecordingTransport(new object[] { 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        AssertTrue(client.PendingEvents() == 1, "frozen restart did not recover its event");
        AssertTrue(client.Flush().StatusCode == 202, "frozen restart flush failed");
        AssertTrue(transport.SentBodies.Count == 1 && transport.SentBodies[0] == expectedBody, "frozen restart body changed");
        AssertTrue(client.Shutdown().StatusCode == 204, "frozen restart shutdown failed");
    }

    private static void LocalAcknowledgementFailureRetainsExactPrefix()
    {
        using var root = new TemporaryDirectory();
        var transport = new RecordingTransport(new object[] { 202, 202 });
        var client = CreateDurableClient(root.Path, transport: transport);
        client.Log("evt_ack_failure", "2026-06-02T10:00:03Z", LogAttributes.Create("ack failure", "info"));
        var hooks = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreTestHooks", throwOnError: true)!;
        var checkpoint = hooks.GetProperty("Checkpoint", BindingFlags.Static | BindingFlags.NonPublic)!;
        checkpoint.SetValue(null, new Action<string>(name =>
        {
            if (name == "acknowledgement_persisted")
            {
                throw new IOException("simulated local acknowledgement interruption");
            }
        }));

        try
        {
            ExpectStorageFailure(() => client.Flush());
            AssertTrue(client.PendingEvents() == 1, "local acknowledgement failure lost the accepted prefix");
            AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage, "local acknowledgement failure was not storage-paused");
            AssertTrue(transport.SentBodies.Count == 1, "local acknowledgement failure changed the initial request count");
        }
        finally
        {
            checkpoint.SetValue(null, null);
        }

        AssertTrue(client.Flush().StatusCode == 202, "retained prefix retry failed");
        AssertTrue(transport.SentBodies.Count == 2, "retained prefix was not retried exactly once");
        AssertTrue(transport.SentBodies[0] == transport.SentBodies[1], "retained prefix retry bytes changed");
        AssertTrue(client.PendingEvents() == 0, "successful retained prefix retry was not acknowledged");
        AssertTrue(client.Shutdown().StatusCode == 204, "acknowledgement failure client shutdown failed");
    }

    private static void AcknowledgedPrefixCleanupResumesAfterExit()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-ack-checkpoint", root.Path);
        var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
        AssertTrue(File.Exists(System.IO.Path.Combine(child, "delivery-state.lbd")), "acknowledgement marker was not durable before cleanup");
        var transport = new RecordingTransport(new object[] { 202 });
        var client = CreateDurableClient(root.Path, transport: transport);

        AssertTrue(client.PendingEvents() == 0, "acknowledged prefix reappeared after cleanup restart");
        AssertTrue(transport.SentBodies.Count == 0, "acknowledged prefix was sent again after durable acknowledgement");
        AssertTrue(Directory.GetFiles(child).All(path => System.IO.Path.GetFileName(path) == ".owner"), "acknowledged records were not cleaned on restart");
        AssertTrue(client.Shutdown().StatusCode == 204, "acknowledgement cleanup restart shutdown failed");
    }

    private static void KeyRotationSurvivesRecordReplacementExit()
    {
        using var root = new TemporaryDirectory();
        RunDurableChild("--durable-child-write-old-key", root.Path);
        RunDurableChild("--durable-child-rotation-checkpoint", root.Path);
        RunDurableChild("--durable-child-rotation-complete", root.Path);
        using var oldKey = new DurableDeliveryKey("old-key", Enumerable.Repeat((byte)0x21, 32).ToArray());
        using var oldOptions = new DurableDeliveryOptions(root.Path, oldKey);
        var oldBuffer = GetOptionKeyBuffer(oldOptions, "old-key");
        var oldClient = LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            RecordingTransport.AlwaysAccept(),
            oldOptions,
            new AutomaticDeliveryOptions
            {
                FlushAtQueueSize = 100,
                FlushInterval = TimeSpan.FromHours(1),
            });
        AssertTrue(oldClient.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage, "retired old key recovered rotated records");
        AssertTrue(oldClient.Shutdown().StatusCode == 204, "old-key rejection client shutdown failed");
        AssertTrue(oldBuffer.All(value => value == 0), "old-key rejection shutdown did not zero its key buffer");

        var transport = new RecordingTransport(new object[] { 202 });
        using var newKey = new DurableDeliveryKey("new-key", Enumerable.Repeat((byte)0x31, 32).ToArray());
        using var newOptions = new DurableDeliveryOptions(root.Path, newKey);
        var newBuffer = GetOptionKeyBuffer(newOptions, "new-key");
        var client = LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            transport,
            newOptions,
            new AutomaticDeliveryOptions
            {
                FlushAtQueueSize = 100,
                FlushInterval = TimeSpan.FromHours(1),
            });

        AssertTrue(client.PendingEvents() == 2, "rotated restart did not recover the queue with only the new key");
        AssertTrue(client.Flush().StatusCode == 202, "rotated queue flush failed");
        AssertTrue(transport.SentBodies.Count == 1, "rotated queue request count changed");
        AssertTrue(transport.SentBodies[0].IndexOf("evt_rotation_1", StringComparison.Ordinal) < transport.SentBodies[0].IndexOf("evt_rotation_2", StringComparison.Ordinal), "rotated queue order changed");
        AssertTrue(client.Shutdown().StatusCode == 204, "rotated queue shutdown failed");
        AssertTrue(newBuffer.All(value => value == 0), "successful durable shutdown did not zero its key buffer");
    }

    private static void RecoveryAdmissionIsBoundedBeforeRotation()
    {
        using (var countRoot = new TemporaryDirectory())
        {
            RunDurableChild("--durable-child-write-old-key", countRoot.Path);
            var child = System.IO.Path.Combine(countRoot.Path, ".logbrew-delivery-v1");
            var first = System.IO.Path.Combine(child, "event-00000000000000000001.lbd");
            var original = File.ReadAllBytes(first);
            for (var sequence = 3; sequence <= 4; sequence++)
            {
                var path = System.IO.Path.Combine(child, "event-" + sequence.ToString("D20", System.Globalization.CultureInfo.InvariantCulture) + ".lbd");
                File.WriteAllBytes(path, original);
                MakeOwnerOnly(path);
            }

            var client = CreateDurableClientWithKeys(
                countRoot.Path,
                "new-key",
                0x31,
                "old-key",
                0x21,
                maxQueueSize: 3);
            AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage, "excess recovery record count was accepted");
            AssertTrue(File.ReadAllBytes(first).SequenceEqual(original), "count rejection mutated an old-key record before admission");
            AssertTrue(client.Shutdown().StatusCode == 204, "count-bounded recovery shutdown failed");
        }

        using (var bytesRoot = new TemporaryDirectory())
        {
            RunDurableChild("--durable-child-write-old-key", bytesRoot.Path);
            var child = System.IO.Path.Combine(bytesRoot.Path, ".logbrew-delivery-v1");
            var first = System.IO.Path.Combine(child, "event-00000000000000000001.lbd");
            var original = File.ReadAllBytes(first);
            var oversizedRecord = new byte[512 * 1024];
            for (var sequence = 3; sequence <= 4; sequence++)
            {
                var path = System.IO.Path.Combine(child, "event-" + sequence.ToString("D20", System.Globalization.CultureInfo.InvariantCulture) + ".lbd");
                File.WriteAllBytes(path, oversizedRecord);
                MakeOwnerOnly(path);
            }

            var client = CreateDurableClientWithKeys(
                bytesRoot.Path,
                "new-key",
                0x31,
                "old-key",
                0x21,
                maxQueueBytes: 64 * 1024);
            AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage, "excess recovery bytes were accepted");
            AssertTrue(File.ReadAllBytes(first).SequenceEqual(original), "byte rejection mutated an old-key record before admission");
            AssertTrue(client.Shutdown().StatusCode == 204, "byte-bounded recovery shutdown failed");
        }

        using (var tempRoot = new TemporaryDirectory())
        {
            RunDurableChild("--durable-child-write-old-key", tempRoot.Path);
            var child = System.IO.Path.Combine(tempRoot.Path, ".logbrew-delivery-v1");
            var first = System.IO.Path.Combine(child, "event-00000000000000000001.lbd");
            var temporary = System.IO.Path.Combine(child, ".tmp-interrupted");
            File.Copy(first, temporary);
            MakeOwnerOnly(temporary);
            var client = CreateDurableClientWithKeys(tempRoot.Path, "new-key", 0x31, "old-key", 0x21);

            AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage, "interrupted temp record was silently ignored");
            AssertTrue(File.Exists(temporary), "interrupted temp record was silently deleted");
            client.PurgeDurableDelivery();
            AssertTrue(Directory.GetFiles(child).All(path => System.IO.Path.GetFileName(path) == ".owner"), "explicit purge left durable records");
            client.RecoverAutomaticDelivery();
            AssertTrue(client.DeliveryHealth().Lifecycle == DeliveryLifecycleState.Running, "purged client did not recover explicitly");
            AssertTrue(client.Shutdown().StatusCode == 204, "purged recovery shutdown failed");
        }
    }

    private static void DurableSpanArraysAreAccepted()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        client.Span("evt_durable_span", "2026-06-02T10:00:03Z", SpanWithArrays());

        AssertTrue(client.PendingEvents() == 1, "durable span arrays were dropped");
        AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.None, "durable span arrays paused storage");
        AssertTrue(client.Shutdown().StatusCode == 202, "durable span arrays did not flush");
    }

    private static SpanAttributes SpanWithArrays()
    {
        return SpanAttributes.Create(
                "durable-span",
                "11111111111111111111111111111111",
                "2222222222222222",
                "ok")
            .WithEvent(SpanEventSummary.Create("span-event")
                .WithTimestamp("2026-06-02T10:00:03Z")
                .WithMetadata(new System.Collections.Generic.Dictionary<string, object?> { ["attempt"] = 1 }))
            .WithLink(SpanLinkSummary.Create(
                    "33333333333333333333333333333333",
                    "4444444444444444",
                    "01")
                .WithMetadata(new System.Collections.Generic.Dictionary<string, object?> { ["linked"] = true }));
    }

    private static LogBrewClient CreateDurableClient(
        string parentDirectory,
        Action<DroppedEvent>? onEventDropped = null,
        ITransport? transport = null)
    {
        using var key = new DurableDeliveryKey("primary-2026", Enumerable.Repeat((byte)0x31, 32).ToArray());
        using var storage = new DurableDeliveryOptions(parentDirectory, key);
        return LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            transport ?? RecordingTransport.AlwaysAccept(),
            storage,
            new AutomaticDeliveryOptions
            {
                FlushAtQueueSize = 100,
                FlushInterval = TimeSpan.FromHours(1),
            },
            onEventDropped);
    }

    private static LogBrewClient CreateDurableClientWithKeys(
        string parentDirectory,
        string primaryId,
        byte primaryByte,
        string? previousId = null,
        byte previousByte = 0,
        ITransport? transport = null,
        int maxQueueSize = 1000,
        int maxQueueBytes = 4 * 1024 * 1024)
    {
        using var primary = new DurableDeliveryKey(primaryId, Enumerable.Repeat(primaryByte, 32).ToArray());
        using var previous = previousId == null
            ? null
            : new DurableDeliveryKey(previousId, Enumerable.Repeat(previousByte, 32).ToArray());
        var previousKeys = previous == null ? Array.Empty<DurableDeliveryKey>() : new[] { previous };
        using var storage = new DurableDeliveryOptions(parentDirectory, primary, previousKeys);
        return LogBrewClient.CreateAutomaticDurable(
            ApiKey,
            "logbrew-dotnet",
            "0.1.0",
            transport ?? RecordingTransport.AlwaysAccept(),
            storage,
            new AutomaticDeliveryOptions
            {
                FlushAtQueueSize = Math.Min(100, maxQueueSize),
                FlushInterval = TimeSpan.FromHours(1),
                MaxQueueSize = maxQueueSize,
                MaxQueueBytes = maxQueueBytes,
            });
    }

    private static void SetStoreCheckpoint(Action<string>? callback)
    {
        var hooks = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreTestHooks", throwOnError: true)!;
        hooks.GetProperty("Checkpoint", BindingFlags.Static | BindingFlags.NonPublic)!.SetValue(null, callback);
    }

    private static void RunDurableChild(string mode, string parentDirectory)
    {
        var start = new ProcessStartInfo("dotnet")
        {
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            UseShellExecute = false,
        };
        start.ArgumentList.Add(typeof(DurableDeliveryContractTests).Assembly.Location);
        start.ArgumentList.Add(mode);
        start.ArgumentList.Add(parentDirectory);
        using var process = Process.Start(start) ?? throw new InvalidOperationException("durable child did not start");
        if (!process.WaitForExit(10_000))
        {
            process.Kill(entireProcessTree: true);
            process.WaitForExit();
            throw new InvalidOperationException("durable child did not exit");
        }

        var standardOutput = process.StandardOutput.ReadToEnd();
        var standardError = process.StandardError.ReadToEnd();
        AssertTrue(process.ExitCode == 0, "durable child failed: " + standardOutput + standardError);
    }

    private static string CreateOwnedChild(string parentDirectory)
    {
        var child = System.IO.Path.Combine(parentDirectory, ".logbrew-delivery-v1");
        if (OperatingSystem.IsWindows())
        {
            var client = CreateDurableClient(parentDirectory);
            AssertTrue(client.Shutdown().StatusCode == 204, "private Windows child setup shutdown failed");
            File.Delete(System.IO.Path.Combine(child, ".owner"));
            return child;
        }

        Directory.CreateDirectory(child);
        return child;
    }

    private static void ExpectStorageFailure(Action callback)
    {
        try
        {
            callback();
        }
        catch (SdkException error)
        {
            AssertTrue(error.Code == "storage_error", "storage failure code changed");
            AssertTrue(!error.Message.Contains(System.IO.Path.DirectorySeparatorChar, StringComparison.Ordinal), "storage error exposed a path");
            return;
        }

        throw new InvalidOperationException("expected storage failure");
    }

    private static byte[] GetPrivateByteArray(object owner, string fieldName)
    {
        return (byte[])owner.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(owner)!;
    }

    private static byte[] GetOptionKeyBuffer(DurableDeliveryOptions options, string id)
    {
        var keys = options.GetType().GetField("keys", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(options)!;
        var indexer = keys.GetType().GetProperty("Item")!;
        return (byte[])indexer.GetValue(keys, new object[] { id })!;
    }

    private static void MakeOwnerOnly(string path)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException(message);
        }
    }

    private sealed class ExitOnSendTransport : ITransport
    {
        private readonly string bodyPath;

        internal ExitOnSendTransport(string bodyPath)
        {
            this.bodyPath = bodyPath;
        }

        public TransportResponse Send(string apiKey, string body)
        {
            File.WriteAllText(bodyPath, body);
            Environment.Exit(0);
            throw new InvalidOperationException("process exit returned");
        }
    }

    private sealed class TemporaryDirectory : IDisposable
    {
        internal TemporaryDirectory()
        {
            Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "logbrew-dotnet-durable-contract-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(Path);
        }

        internal string Path { get; }

        public void Dispose()
        {
            Directory.Delete(Path, recursive: true);
        }
    }
}
