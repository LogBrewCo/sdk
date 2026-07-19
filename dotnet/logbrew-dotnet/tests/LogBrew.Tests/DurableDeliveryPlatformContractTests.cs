using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading.Tasks;
using LogBrew;

internal static partial class DurableDeliveryContractTests
{
    private static void SupportedPlatformPairsAreExplicit()
    {
        AssertTrue(IsSupported("linux", Architecture.X64), "linux x64 must be supported");
        AssertTrue(IsSupported("linux", Architecture.Arm64), "linux arm64 must be supported");
        AssertTrue(IsSupported("macos", Architecture.X64), "macOS x64 must be supported");
        AssertTrue(IsSupported("macos", Architecture.Arm64), "macOS arm64 must be supported");
        AssertTrue(IsSupported("windows", Architecture.X64), "Windows x64 must be supported");
        AssertTrue(IsSupported("windows", Architecture.Arm64), "Windows arm64 must be supported");
    }

    private static void UnsupportedPlatformPairsFailClosed()
    {
        AssertTrue(!IsSupported("freebsd", Architecture.X64), "unclaimed OS was accepted");
        AssertTrue(!IsSupported("linux", Architecture.X86), "unclaimed architecture was accepted");
        AssertTrue(!IsSupported("windows", Architecture.Wasm), "Wasm was accepted");
        AssertTrue(!IsSupported("unknown", Architecture.Arm64), "unknown platform was accepted");
    }

    private static void UnixNativeLibraryCandidatesAreExplicit()
    {
        AssertTrue(
            UnixNativeLibraryCandidates("linux", Architecture.X64)
                .SequenceEqual(new[] { "libc.so.6", "libc.musl-x86_64.so.1", "ld-musl-x86_64.so.1" }),
            "linux x64 libc candidates changed");
        AssertTrue(
            UnixNativeLibraryCandidates("linux", Architecture.Arm64)
                .SequenceEqual(new[] { "libc.so.6", "libc.musl-aarch64.so.1", "ld-musl-aarch64.so.1" }),
            "linux arm64 libc candidates changed");
        AssertTrue(
            UnixNativeLibraryCandidates("macos", Architecture.X64)
                .SequenceEqual(new[] { "libSystem.B.dylib" }),
            "macOS x64 system library candidate changed");
        AssertTrue(
            UnixNativeLibraryCandidates("macos", Architecture.Arm64)
                .SequenceEqual(new[] { "libSystem.B.dylib" }),
            "macOS arm64 system library candidate changed");
    }

    private static void UnsupportedUnixNativeLibraryCandidatesFailClosed()
    {
        AssertTrue(UnixNativeLibraryCandidates("linux", Architecture.X86).Length == 0, "linux x86 received libc candidates");
        AssertTrue(UnixNativeLibraryCandidates("windows", Architecture.X64).Length == 0, "Windows received Unix library candidates");
        AssertTrue(UnixNativeLibraryCandidates("unknown", Architecture.Arm64).Length == 0, "unknown OS received libc candidates");
    }

    private static void UnixNativeExportsAreExplicit()
    {
        var common = new[] { "open", "openat", "mkdirat", "flock", "fchmod", "linkat", "unlinkat", "renameat", "fsync" };
        AssertTrue(
            UnixNativeRequiredExports("linux", Architecture.X64).SequenceEqual(common.Append("statx")),
            "linux x64 native exports changed");
        AssertTrue(
            UnixNativeRequiredExports("linux", Architecture.Arm64).SequenceEqual(common.Append("statx")),
            "linux arm64 native exports changed");
        AssertTrue(
            UnixNativeRequiredExports("macos", Architecture.X64).SequenceEqual(common.Append("fstat").Append("fstat$INODE64")),
            "macOS x64 native exports changed");
        AssertTrue(
            UnixNativeRequiredExports("macos", Architecture.Arm64).SequenceEqual(common.Append("fstat")),
            "macOS arm64 native exports changed");
        AssertTrue(UnixNativeRequiredExports("windows", Architecture.X64).Length == 0, "Windows received Unix native exports");
    }

    private static void UnixNativeInitializationIsConcurrentAndStable()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var native = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableUnixNative", throwOnError: true)!;
        var initialize = native.GetMethod("IsAvailable", BindingFlags.Static | BindingFlags.NonPublic)!;
        var attempts = Enumerable.Range(0, 32)
            .Select(_ => Task.Run(() => (bool)initialize.Invoke(null, null)!))
            .ToArray();
        Task.WaitAll(attempts);
        AssertTrue(attempts.All(attempt => attempt.Result), "concurrent Unix native initialization failed");
    }

    private static void UnixOpenImportsMatchVariadicArity()
    {
        var fileSystem = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreFileSystem", throwOnError: true)!;
        var open = fileSystem.GetMethod("OpenUnix", BindingFlags.Static | BindingFlags.NonPublic)!;
        var openAt = fileSystem.GetMethod("OpenAtUnix", BindingFlags.Static | BindingFlags.NonPublic)!;
        var createAt = fileSystem.GetMethod("OpenAtCreateUnix", BindingFlags.Static | BindingFlags.NonPublic)!;
        AssertTrue(open.GetParameters().Length == 2, "existing open import passed an optional mode");
        AssertTrue(openAt.GetParameters().Length == 3, "existing openat import passed an optional mode");
        AssertTrue(createAt.GetParameters().Length == 4, "creating openat import omitted its required mode");
    }

    private static void LinuxOpenFlagsMatchArchitectureAbi()
    {
        var fileSystem = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreFileSystem", throwOnError: true)!;
        var directoryFlag = fileSystem.GetMethod("LinuxDirectoryFlag", BindingFlags.Static | BindingFlags.NonPublic)!;
        var noFollowFlag = fileSystem.GetMethod("LinuxNoFollowFlag", BindingFlags.Static | BindingFlags.NonPublic)!;

        AssertTrue((int)directoryFlag.Invoke(null, new object[] { Architecture.X64 })! == 0x10000, "Linux x64 directory flag changed");
        AssertTrue((int)noFollowFlag.Invoke(null, new object[] { Architecture.X64 })! == 0x20000, "Linux x64 no-follow flag changed");
        AssertTrue((int)directoryFlag.Invoke(null, new object[] { Architecture.Arm64 })! == 0x4000, "Linux arm64 directory flag changed");
        AssertTrue((int)noFollowFlag.Invoke(null, new object[] { Architecture.Arm64 })! == 0x8000, "Linux arm64 no-follow flag changed");
    }

    private static void WindowsFileInformationMatchesNativeAbi()
    {
        var reader = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableFileIdentityReader", throwOnError: true)!;
        var information = reader.GetNestedType("WindowsFileInformation", BindingFlags.NonPublic)!;
        var expectedOffsets = new (string Field, int Offset)[]
        {
            ("FileAttributes", 0),
            ("CreationTime", 4),
            ("LastAccessTime", 12),
            ("LastWriteTime", 20),
            ("VolumeSerialNumber", 28),
            ("FileSizeHigh", 32),
            ("FileSizeLow", 36),
            ("NumberOfLinks", 40),
            ("FileIndexHigh", 44),
            ("FileIndexLow", 48),
        };

        AssertTrue(Marshal.SizeOf(information) == 52, "Windows file information native size changed");
        foreach (var (field, offset) in expectedOffsets)
        {
            AssertTrue(Marshal.OffsetOf(information, field).ToInt32() == offset, "Windows file information " + field + " offset changed");
        }
    }

    private static void WindowsEncryptedDeliveryVersionFloorIsExplicit()
    {
        var platform = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurablePlatformSupport", throwOnError: true)!;
        var minimumBuild = platform.GetMethod("WindowsMinimumBuild", BindingFlags.Static | BindingFlags.NonPublic);
        AssertTrue(minimumBuild != null, "Windows durable version floor is missing");
        AssertTrue((int)minimumBuild!.Invoke(null, null)! == 16299, "Windows durable version floor changed");
    }

    private static void WindowsReplacementIsHandleBoundAndPosixSafe()
    {
        var fileSystem = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreFileSystem", throwOnError: true)!;
        var creationAccess = fileSystem.GetMethod("WindowsRecordCreationAccess", BindingFlags.Static | BindingFlags.NonPublic);
        var access = fileSystem.GetMethod("WindowsReplacementAccess", BindingFlags.Static | BindingFlags.NonPublic);
        var informationClass = fileSystem.GetMethod("WindowsReplacementInformationClass", BindingFlags.Static | BindingFlags.NonPublic);
        var flags = fileSystem.GetMethod("WindowsReplacementFlags", BindingFlags.Static | BindingFlags.NonPublic);
        var fileNameOffset = fileSystem.GetMethod("WindowsReplacementFileNameOffset", BindingFlags.Static | BindingFlags.NonPublic);
        AssertTrue(
            creationAccess != null && access != null && informationClass != null && flags != null && fileNameOffset != null,
            "Windows handle-bound replacement contract is missing");

        AssertTrue((uint)creationAccess!.Invoke(null, null)! == 0xC0000000, "Windows record creation access changed");
        AssertTrue((uint)access!.Invoke(null, null)! == 0xC0010000, "Windows replacement access changed");
        AssertTrue((int)informationClass!.Invoke(null, null)! == 22, "Windows replacement information class changed");
        AssertTrue((uint)flags!.Invoke(null, null)! == 3, "Windows replacement flags changed");
        AssertTrue(
            (int)fileNameOffset!.Invoke(null, null)! == (IntPtr.Size == 8 ? 20 : 12),
            "Windows replacement buffer layout changed");
    }

    private static void WindowsPublishedRecordValidationSharesActiveWriter()
    {
        var fileSystem = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreFileSystem", throwOnError: true)!;
        var shareMode = fileSystem.GetMethod("WindowsRecordShareMode", BindingFlags.Static | BindingFlags.NonPublic);
        AssertTrue(shareMode != null, "Windows record share-mode contract is missing");

        AssertTrue((uint)shareMode!.Invoke(null, new object[] { false, false })! == 1, "normal record reads changed sharing");
        AssertTrue((uint)shareMode.Invoke(null, new object[] { true, false })! == 5, "deletable record reads changed sharing");
        AssertTrue((uint)shareMode.Invoke(null, new object[] { false, true })! == 3, "published record validation omitted writer sharing");
        AssertTrue((uint)shareMode.Invoke(null, new object[] { true, true })! == 7, "replace validation changed sharing");
    }

    private static void WindowsDeletionIsHandleBoundAndFailsClosed()
    {
        var fileSystem = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableStoreFileSystem", throwOnError: true)!;
        var access = fileSystem.GetMethod("WindowsDeleteAccess", BindingFlags.Static | BindingFlags.NonPublic);
        var flags = fileSystem.GetMethod("WindowsDeleteFlags", BindingFlags.Static | BindingFlags.NonPublic);
        var informationClass = fileSystem.GetMethod("WindowsDeleteInformationClass", BindingFlags.Static | BindingFlags.NonPublic);
        var informationFlags = fileSystem.GetMethod("WindowsDeleteInformationFlags", BindingFlags.Static | BindingFlags.NonPublic);
        var informationSize = fileSystem.GetMethod("WindowsDeleteInformationSize", BindingFlags.Static | BindingFlags.NonPublic);
        var isMissing = fileSystem.GetMethod("IsWindowsMissingRecordError", BindingFlags.Static | BindingFlags.NonPublic);
        AssertTrue(
            access != null
                && flags != null
                && informationClass != null
                && informationFlags != null
                && informationSize != null
                && isMissing != null,
            "Windows handle-bound deletion contract is missing");

        AssertTrue((uint)access!.Invoke(null, null)! == 0x80010000, "Windows deletion access changed");
        AssertTrue((uint)flags!.Invoke(null, null)! == 0x00200000, "Windows deletion flags changed");
        AssertTrue((int)informationClass!.Invoke(null, null)! == 21, "Windows deletion information class changed");
        AssertTrue((uint)informationFlags!.Invoke(null, null)! == 3, "Windows deletion information flags changed");
        AssertTrue((int)informationSize!.Invoke(null, null)! == 4, "Windows deletion information size changed");
        AssertTrue((bool)isMissing!.Invoke(null, new object[] { 2 })!, "missing-file deletion was not idempotent");
        AssertTrue((bool)isMissing.Invoke(null, new object[] { 3 })!, "missing-path deletion was not idempotent");
        AssertTrue(!(bool)isMissing.Invoke(null, new object[] { 5 })!, "access-denied deletion was accepted as missing");
    }

    private static void MacOSX64StoreIdentityUsesModernInodeAbi()
    {
        if (!OperatingSystem.IsMacOS() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
        {
            return;
        }

        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        try
        {
            var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
            var owner = System.IO.Path.Combine(child, ".owner");
            AssertTrue(Directory.Exists(child), "macOS x64 durable child was not created");
            AssertTrue(File.Exists(owner), "macOS x64 durable owner was not created");
            AssertTrue(
                File.GetUnixFileMode(child)
                    == (UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute),
                "macOS x64 durable child mode changed");
            AssertTrue(
                File.GetUnixFileMode(owner) == (UnixFileMode.UserRead | UnixFileMode.UserWrite),
                "macOS x64 durable owner mode changed");
        }
        finally
        {
            AssertTrue(client.Shutdown().StatusCode == 204, "macOS x64 durable shutdown failed");
        }
    }

    private static void SafeHandleIdentityRecognizesRegularFiles()
    {
        using var root = new TemporaryDirectory();
        var file = System.IO.Path.Combine(root.Path, "identity");
        using var stream = new FileStream(file, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None);
        var reader = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableFileIdentityReader", throwOnError: true)!;
        var read = reader.GetMethod("Read", BindingFlags.Static | BindingFlags.NonPublic)!;
        var identity = read.Invoke(null, new object[] { stream.SafeFileHandle })!;
        var identityType = identity.GetType();
        var isDirectory = (bool)identityType.GetProperty("IsDirectory", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(identity)!;
        var linkCount = (uint)identityType.GetProperty("LinkCount", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(identity)!;
        AssertTrue(!isDirectory, "regular file was classified as a directory");
        AssertTrue(linkCount == 1, "regular file link count was " + linkCount.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static void OwnerSymlinkFailsClosed()
    {
        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        var target = System.IO.Path.Combine(root.Path, "unrelated");
        File.WriteAllText(target, "unchanged");
        File.CreateSymbolicLink(System.IO.Path.Combine(child, ".owner"), target);
        ExpectStorageFailure(() => CreateDurableClient(root.Path));
        AssertTrue(File.ReadAllText(target) == "unchanged", "owner symlink target was mutated");
    }

    private static void ChildSymlinkFailsClosed()
    {
        using var root = new TemporaryDirectory();
        var target = System.IO.Path.Combine(root.Path, "unrelated-directory");
        Directory.CreateDirectory(target);
        var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
        Directory.CreateSymbolicLink(child, target);

        ExpectStorageFailure(() => CreateDurableClient(root.Path));

        AssertTrue(Directory.GetFileSystemEntries(target).Length == 0, "child symlink target was mutated");
    }

    private static void BroadChildFailsBeforeMutation()
    {
        if (OperatingSystem.IsWindows())
        {
            using (var broadRoot = new TemporaryDirectory())
            {
                var broadChild = CreateOwnedChild(broadRoot.Path);
                SetBroadWindowsAccess(broadChild, isDirectory: true);
                var originalSecurity = WindowsSecurityBytes(broadChild, isDirectory: true);

                ExpectStorageFailure(() => CreateDurableClient(broadRoot.Path));

                var currentSecurity = WindowsSecurityBytes(broadChild, isDirectory: true);
                AssertTrue(originalSecurity.SequenceEqual(currentSecurity), "broad child permissions were mutated");
                AssertTrue(Directory.GetFileSystemEntries(broadChild).Length == 0, "broad child received durable files");
            }

            using var nonInheritableRoot = new TemporaryDirectory();
            var nonInheritableChild = CreateOwnedChild(nonInheritableRoot.Path);
            SetOwnerOnlyWindowsAccess(nonInheritableChild, InheritanceFlags.None);
            var nonInheritableSecurity = WindowsSecurityBytes(nonInheritableChild, isDirectory: true);

            ExpectStorageFailure(() => CreateDurableClient(nonInheritableRoot.Path));

            AssertTrue(
                nonInheritableSecurity.SequenceEqual(WindowsSecurityBytes(nonInheritableChild, isDirectory: true)),
                "non-inheritable child permissions were mutated");
            AssertTrue(
                Directory.GetFileSystemEntries(nonInheritableChild).Length == 0,
                "non-inheritable child received durable files");
            return;
        }

        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        var broadMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute;
        File.SetUnixFileMode(child, broadMode);

        ExpectStorageFailure(() => CreateDurableClient(root.Path));

        AssertTrue(File.GetUnixFileMode(child) == broadMode, "broad child permissions were mutated");
        AssertTrue(Directory.GetFileSystemEntries(child).Length == 0, "broad child received durable files");
    }

    private static void OwnerHardLinkFailsClosed()
    {
        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        var target = System.IO.Path.Combine(root.Path, "unrelated");
        File.WriteAllText(target, "unchanged");
        var originalAttributes = File.GetAttributes(target);
        var originalMode = OperatingSystem.IsWindows() ? default : File.GetUnixFileMode(target);
        CreateHardLink(System.IO.Path.Combine(child, ".owner"), target);
        ExpectStorageFailure(() => CreateDurableClient(root.Path));
        AssertTrue(File.ReadAllText(target) == "unchanged", "owner hard-link target was mutated");
        AssertTrue(File.GetAttributes(target) == originalAttributes, "owner hard-link target attributes changed");
        if (!OperatingSystem.IsWindows())
        {
            AssertTrue(File.GetUnixFileMode(target) == originalMode, "owner hard-link target permissions changed");
        }
    }

    private static void BroadExistingStoreEntriesFailWithoutMutation()
    {
        if (OperatingSystem.IsWindows())
        {
            using (var ownerRoot = new TemporaryDirectory())
            {
                var client = CreateDurableClient(ownerRoot.Path);
                AssertTrue(client.Shutdown().StatusCode == 204, "owner setup shutdown failed");
                var ownerPath = System.IO.Path.Combine(ownerRoot.Path, ".logbrew-delivery-v1", ".owner");
                SetBroadWindowsAccess(ownerPath, isDirectory: false);
                var originalSecurity = WindowsSecurityBytes(ownerPath, isDirectory: false);
                ExpectStorageFailure(() => CreateDurableClient(ownerRoot.Path));
                AssertTrue(
                    originalSecurity.SequenceEqual(WindowsSecurityBytes(ownerPath, isDirectory: false)),
                    "broad owner permissions were mutated");
            }

            using (var recordRoot = new TemporaryDirectory())
            {
                var client = CreateDurableClient(recordRoot.Path);
                AssertTrue(client.Shutdown().StatusCode == 204, "record setup shutdown changed");
                var recordChild = System.IO.Path.Combine(recordRoot.Path, ".logbrew-delivery-v1");
                var record = System.IO.Path.Combine(recordChild, "event-broad.lbd");
                File.WriteAllText(record, "unchanged-record");
                SetBroadWindowsAccess(record, isDirectory: false);
                var originalSecurity = WindowsSecurityBytes(record, isDirectory: false);
                var rejected = CreateDurableClient(recordRoot.Path);
                AssertTrue(
                    rejected.DeliveryHealth().PauseReason == DeliveryPauseReason.Storage,
                    "broad record did not pause durable recovery");
                AssertTrue(rejected.Shutdown().StatusCode == 204, "broad record shutdown failed");
                AssertTrue(
                    originalSecurity.SequenceEqual(WindowsSecurityBytes(record, isDirectory: false)),
                    "broad record permissions were mutated");
            }

            return;
        }

        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        File.SetUnixFileMode(child, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var owner = System.IO.Path.Combine(child, ".owner");
        File.WriteAllText(owner, "unchanged-owner");
        var broadMode = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.GroupRead;
        File.SetUnixFileMode(owner, broadMode);

        ExpectStorageFailure(() => CreateDurableClient(root.Path));

        AssertTrue(File.ReadAllText(owner) == "unchanged-owner", "broad owner bytes changed");
        AssertTrue(File.GetUnixFileMode(owner) == broadMode, "broad owner permissions changed");
    }

    private static void PrivateExistingOwnerRemainsUnchanged()
    {
        if (OperatingSystem.IsWindows())
        {
            using var windowsRoot = new TemporaryDirectory();
            SetBroadWindowsAccess(windowsRoot.Path, isDirectory: true);
            var windowsClient = CreateDurableClient(windowsRoot.Path);
            windowsClient.Log("evt_windows_private_store", "2026-06-02T10:00:03Z", LogAttributes.Create("private store", "info"));
            AssertTrue(windowsClient.PendingEvents() == 1, "private Windows store rejected durable admission");
            var windowsChild = System.IO.Path.Combine(windowsRoot.Path, ".logbrew-delivery-v1");
            AssertWindowsOwnerOnly(windowsChild, isDirectory: true, requireProtected: true);
            AssertWindowsOwnerOnly(System.IO.Path.Combine(windowsChild, ".owner"), isDirectory: false, requireProtected: false);
            AssertWindowsOwnerOnly(Directory.GetFiles(windowsChild, "event-*.lbd").Single(), isDirectory: false, requireProtected: false);
            AssertTrue(windowsClient.Shutdown().StatusCode == 202, "private Windows store shutdown failed");
            return;
        }

        using var root = new TemporaryDirectory();
        var child = CreateOwnedChild(root.Path);
        File.SetUnixFileMode(child, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        var owner = System.IO.Path.Combine(child, ".owner");
        File.WriteAllText(owner, "private-owner");
        var privateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        File.SetUnixFileMode(owner, privateMode);

        var client = CreateDurableClient(root.Path);
        AssertTrue(client.Shutdown().StatusCode == 204, "private owner client shutdown failed");

        AssertTrue(File.ReadAllText(owner) == "private-owner", "private owner bytes changed");
        AssertTrue(File.GetUnixFileMode(owner) == privateMode, "private owner permissions changed");
    }

    private static void ConcurrentOwnerFailsClosed()
    {
        using var root = new TemporaryDirectory();
        var owner = CreateDurableClient(root.Path);
        ExpectStorageFailure(() => CreateDurableClient(root.Path));
        AssertTrue(owner.Shutdown().StatusCode == 204, "owner shutdown failed");
    }

    private static void ParentReplacementPausesBeforeAdmission()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        var moved = root.Path + "-moved";
        if (OperatingSystem.IsWindows())
        {
            AssertWindowsReplacementBlocked(client, () => Directory.Move(root.Path, moved), "evt_parent_replaced");
            return;
        }

        Directory.Move(root.Path, moved);
        Directory.CreateDirectory(root.Path);
        CaptureAfterReplacement(client, "evt_parent_replaced");
        AssertTrue(Directory.GetFileSystemEntries(root.Path).Length == 0, "replacement parent was mutated");
        Directory.Delete(root.Path);
        Directory.Move(moved, root.Path);
        AssertTrue(client.Shutdown().StatusCode == 204, "parent replacement shutdown failed");
    }

    private static void ChildReplacementPausesBeforeAdmission()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        var child = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1");
        var moved = child + "-moved";
        if (OperatingSystem.IsWindows())
        {
            AssertWindowsReplacementBlocked(client, () => Directory.Move(child, moved), "evt_child_replaced");
            return;
        }

        Directory.Move(child, moved);
        Directory.CreateDirectory(child);
        CaptureAfterReplacement(client, "evt_child_replaced");
        AssertTrue(Directory.GetFileSystemEntries(child).Length == 0, "replacement child was mutated");
        Directory.Delete(child);
        Directory.Move(moved, child);
        AssertTrue(client.Shutdown().StatusCode == 204, "child replacement shutdown failed");
    }

    private static void OwnerReplacementPausesBeforeAdmission()
    {
        using var root = new TemporaryDirectory();
        var client = CreateDurableClient(root.Path);
        var owner = System.IO.Path.Combine(root.Path, ".logbrew-delivery-v1", ".owner");
        var moved = owner + ".moved";
        if (OperatingSystem.IsWindows())
        {
            AssertWindowsReplacementBlocked(client, () => File.Move(owner, moved), "evt_owner_replaced");
            return;
        }

        File.Move(owner, moved);
        File.WriteAllText(owner, string.Empty);
        CaptureAfterReplacement(client, "evt_owner_replaced");
        AssertTrue(new FileInfo(owner).Length == 0, "replacement owner was mutated");
        File.Delete(owner);
        File.Move(moved, owner);
        AssertTrue(client.Shutdown().StatusCode == 204, "owner replacement shutdown failed");
    }

    private static void AssertWindowsReplacementBlocked(LogBrewClient client, Action replacement, string eventId)
    {
        try
        {
            replacement();
        }
        catch (IOException)
        {
            client.Log(eventId, "2026-06-02T10:00:03Z", LogAttributes.Create("replacement blocked", "info"));
            AssertTrue(client.PendingEvents() == 1, "blocked replacement prevented durable admission");
            AssertTrue(client.DeliveryHealth().PauseReason == DeliveryPauseReason.None, "blocked replacement paused storage");
            AssertTrue(client.Shutdown().StatusCode == 202, "blocked replacement shutdown failed");
            return;
        }

        throw new InvalidOperationException("Windows replacement unexpectedly succeeded");
    }

    private static void CaptureAfterReplacement(LogBrewClient client, string eventId)
    {
        client.Log(eventId, "2026-06-02T10:00:03Z", LogAttributes.Create("replacement", "info"));
        var health = client.DeliveryHealth();
        AssertTrue(health.Lifecycle == DeliveryLifecycleState.Paused, "replacement did not pause delivery");
        AssertTrue(health.PauseReason == DeliveryPauseReason.Storage, "replacement pause was not typed as storage");
        AssertTrue(client.PendingEvents() == 0, "replacement capture entered memory without durable admission");
    }

    private static bool IsSupported(string operatingSystem, Architecture architecture)
    {
        var support = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurablePlatformSupport", throwOnError: true)!;
        var method = support.GetMethod("IsSupported", BindingFlags.Static | BindingFlags.NonPublic)!;
        return (bool)method.Invoke(null, new object[] { operatingSystem, architecture })!;
    }

    private static string[] UnixNativeLibraryCandidates(string operatingSystem, Architecture architecture)
    {
        var native = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableUnixNative", throwOnError: true)!;
        var method = native.GetMethod("LibraryCandidates", BindingFlags.Static | BindingFlags.NonPublic)!;
        return (string[])method.Invoke(null, new object[] { operatingSystem, architecture })!;
    }

    private static string[] UnixNativeRequiredExports(string operatingSystem, Architecture architecture)
    {
        var native = typeof(LogBrewClient).Assembly.GetType("LogBrew.DurableUnixNative", throwOnError: true)!;
        var method = native.GetMethod("RequiredExports", BindingFlags.Static | BindingFlags.NonPublic)!;
        return (string[])method.Invoke(null, new object[] { operatingSystem, architecture })!;
    }

    private static void CreateHardLink(string linkPath, string targetPath)
    {
        if (OperatingSystem.IsWindows())
        {
            AssertTrue(CreateHardLinkWindows(linkPath, targetPath, IntPtr.Zero), "could not create test hard link");
            return;
        }

        AssertTrue(CreateHardLinkUnix(targetPath, linkPath) == 0, "could not create test hard link");
    }

    [SupportedOSPlatform("windows")]
    private static void SetBroadWindowsAccess(string path, bool isDirectory)
    {
        FileSystemSecurity security = isDirectory ? new DirectorySecurity() : new FileSecurity();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(
            new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            FileSystemRights.FullControl,
            isDirectory ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None,
            PropagationFlags.None,
            AccessControlType.Allow));
        if (isDirectory)
        {
            new DirectoryInfo(path).SetAccessControl((DirectorySecurity)security);
        }
        else
        {
            new FileInfo(path).SetAccessControl((FileSecurity)security);
        }
    }

    [SupportedOSPlatform("windows")]
    private static void SetOwnerOnlyWindowsAccess(string path, InheritanceFlags inheritanceFlags)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new InvalidOperationException("Windows test owner is unavailable");
        var security = new DirectorySecurity();
        security.SetOwner(owner);
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new FileSystemAccessRule(
            owner,
            FileSystemRights.FullControl,
            inheritanceFlags,
            PropagationFlags.None,
            AccessControlType.Allow));
        new DirectoryInfo(path).SetAccessControl(security);
    }

    [SupportedOSPlatform("windows")]
    private static byte[] WindowsSecurityBytes(string path, bool isDirectory)
    {
        return isDirectory
            ? new DirectoryInfo(path).GetAccessControl().GetSecurityDescriptorBinaryForm()
            : new FileInfo(path).GetAccessControl().GetSecurityDescriptorBinaryForm();
    }

    [SupportedOSPlatform("windows")]
    private static void AssertWindowsOwnerOnly(string path, bool isDirectory, bool requireProtected)
    {
        FileSystemSecurity security = isDirectory
            ? new DirectoryInfo(path).GetAccessControl()
            : new FileInfo(path).GetAccessControl();
        using var identity = WindowsIdentity.GetCurrent();
        var owner = identity.User ?? throw new InvalidOperationException("Windows test owner is unavailable");
        var rules = security
            .GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier))
            .Cast<FileSystemAccessRule>()
            .ToArray();
        var actualOwner = security.GetOwner(typeof(SecurityIdentifier));
        AssertTrue(actualOwner != null && actualOwner.Equals(owner), "Windows owner SID changed");
        AssertTrue(!requireProtected || security.AreAccessRulesProtected, "Windows child DACL was not protected");
        AssertTrue(rules.Length == 1, "Windows DACL contained extra access rules");
        AssertTrue(rules[0].AccessControlType == AccessControlType.Allow, "Windows owner access was not allowed");
        AssertTrue(rules[0].IdentityReference.Equals(owner), "Windows DACL granted a different principal");
        AssertTrue(
            (rules[0].FileSystemRights & FileSystemRights.FullControl) == FileSystemRights.FullControl,
            "Windows owner did not receive full control");
        if (isDirectory && requireProtected)
        {
            AssertTrue(
                rules[0].InheritanceFlags == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit),
                "Windows child DACL did not inherit to containers and objects");
            AssertTrue(rules[0].PropagationFlags == PropagationFlags.None, "Windows child DACL changed propagation semantics");
        }
    }

    [LibraryImport("libc", EntryPoint = "link", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int CreateHardLinkUnix(string targetPath, string linkPath);

    [LibraryImport("kernel32.dll", EntryPoint = "CreateHardLinkW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool CreateHardLinkWindows(string linkPath, string targetPath, IntPtr securityAttributes);
}
