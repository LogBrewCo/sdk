using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

internal static partial class LinuxDurableStoragePreflight
{
    private const string ChildDirectoryName = ".logbrew-delivery-v1";
    private const string OwnerFileName = ".owner";
    private const int ReadWrite = 2;
    private const int Create = 0x40;
    private const int Exclusive = 0x80;
    private const int CloseOnExec = 0x80000;
    private const int LockExclusiveNonBlocking = 6;
    private const int AtNoAutomount = 0x800;
    private const int AtEmptyPath = 0x1000;
    private const uint StatxBasicStats = 0x07ff;
    private const uint StatxMountId = 0x1000;
    private const int FileTypeMask = 0xF000;
    private const int DirectoryType = 0x4000;
    private const int RegularFileType = 0x8000;
    private const uint PrivateDirectoryMode = 0x1c0;
    private const uint PrivateFileMode = 0x180;
    private const int PermissionDenied = 1;
    private const int MissingEntry = 2;
    private const int AccessDenied = 13;
    private const int NotDirectory = 20;
    private const int InvalidArgument = 22;
    private const int SymbolicLinkLoop = 40;

    internal static bool Run(string parentPath, Action<string> record)
    {
        var failureStage = "linux-storage-preflight-failed-native-bind";
        SafeFileHandle? parent = null;
        SafeFileHandle? child = null;
        SafeFileHandle? owner = null;
        var operationsPassed = false;
        try
        {
            if (!LogBrew.DurableUnixNative.IsAvailable())
            {
                throw new InvalidOperationException();
            }

            var parentDescriptor = OpenUnix(parentPath, LinuxDirectoryFlag() | LinuxNoFollowFlag() | CloseOnExec);
            if (parentDescriptor < 0)
            {
                failureStage = ParentOpenFailureStage(Marshal.GetLastPInvokeError());
                throw new InvalidOperationException();
            }

            parent = RequireHandle(parentDescriptor);

            failureStage = "linux-storage-preflight-failed-parent-statx";
            RequireDirectory(ReadIdentity(parent), expectedMode: null);

            failureStage = "linux-storage-preflight-failed-child-mkdir-open";
            RequireSuccess(MakeDirectoryAtUnix(Descriptor(parent), ChildDirectoryName, PrivateDirectoryMode));
            child = RequireHandle(OpenAtUnix(
                Descriptor(parent),
                ChildDirectoryName,
                LinuxDirectoryFlag() | LinuxNoFollowFlag() | CloseOnExec));

            failureStage = "linux-storage-preflight-failed-child-statx";
            RequireDirectory(ReadIdentity(child), PrivateDirectoryMode);

            failureStage = "linux-storage-preflight-failed-owner-create-open";
            owner = RequireHandle(OpenAtCreateUnix(
                Descriptor(child),
                OwnerFileName,
                ReadWrite | Create | Exclusive | LinuxNoFollowFlag() | CloseOnExec,
                PrivateFileMode));

            failureStage = "linux-storage-preflight-failed-owner-statx-mode";
            RequireSingleLinkFile(ReadIdentity(owner));
            RequireSuccess(ChangeModeUnix(Descriptor(owner), PrivateFileMode));
            RequirePrivateFile(ReadIdentity(owner));

            failureStage = "linux-storage-preflight-failed-owner-lock";
            RequireSuccess(LockUnix(Descriptor(owner), LockExclusiveNonBlocking));
            operationsPassed = true;
        }
        catch (Exception)
        {
        }
        finally
        {
            owner?.Dispose();
            child?.Dispose();
            parent?.Dispose();
        }

        if (!operationsPassed)
        {
            TryDelete(parentPath);
            record(failureStage);
            return false;
        }

        try
        {
            Directory.Delete(parentPath, recursive: true);
        }
        catch (Exception)
        {
            record("linux-storage-preflight-failed-root-remove");
            return false;
        }

        record("linux-storage-preflight-passed");
        return true;
    }

    private static SafeFileHandle RequireHandle(int descriptor)
    {
        var handle = new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
        if (handle.IsInvalid)
        {
            handle.Dispose();
            throw new InvalidOperationException();
        }

        return handle;
    }

    private static int Descriptor(SafeFileHandle handle)
    {
        return checked((int)handle.DangerousGetHandle());
    }

    private static LinuxFileStatus ReadIdentity(SafeFileHandle handle)
    {
        if (StatxUnix(
            Descriptor(handle),
            string.Empty,
            AtEmptyPath | AtNoAutomount,
            StatxBasicStats | StatxMountId,
            out var status) != 0)
        {
            throw new InvalidOperationException();
        }

        return status;
    }

    private static void RequireDirectory(LinuxFileStatus status, uint? expectedMode)
    {
        if ((status.Mode & FileTypeMask) != DirectoryType
            || (expectedMode is not null && (uint)(status.Mode & 0x01ff) != expectedMode.Value))
        {
            throw new InvalidOperationException();
        }
    }

    private static void RequireSingleLinkFile(LinuxFileStatus status)
    {
        if ((status.Mode & FileTypeMask) != RegularFileType
            || status.LinkCount != 1)
        {
            throw new InvalidOperationException();
        }
    }

    private static void RequirePrivateFile(LinuxFileStatus status)
    {
        RequireSingleLinkFile(status);
        if ((uint)(status.Mode & 0x01ff) != PrivateFileMode)
        {
            throw new InvalidOperationException();
        }
    }

    private static void RequireSuccess(int result)
    {
        if (result != 0)
        {
            throw new InvalidOperationException();
        }
    }

    private static int LinuxDirectoryFlag()
    {
        return RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => 0x10000,
            Architecture.Arm64 => 0x4000,
            _ => throw new InvalidOperationException(),
        };
    }

    private static int LinuxNoFollowFlag()
    {
        return RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => 0x20000,
            Architecture.Arm64 => 0x8000,
            _ => throw new InvalidOperationException(),
        };
    }

    private static string ParentOpenFailureStage(int error)
    {
        return error switch
        {
            MissingEntry => "linux-storage-preflight-failed-parent-open-missing",
            PermissionDenied or AccessDenied => "linux-storage-preflight-failed-parent-open-denied",
            NotDirectory or InvalidArgument or SymbolicLinkLoop => "linux-storage-preflight-failed-parent-open-invalid",
            _ => "linux-storage-preflight-failed-parent-open-other",
        };
    }

    private static void TryDelete(string parentPath)
    {
        try
        {
            Directory.Delete(parentPath, recursive: true);
        }
        catch (Exception)
        {
        }
    }

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int OpenUnix(string path, int flags);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int OpenAtUnix(int directoryDescriptor, string path, int flags);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int OpenAtCreateUnix(int directoryDescriptor, string path, int flags, uint mode);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "mkdirat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int MakeDirectoryAtUnix(int directoryDescriptor, string path, uint mode);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "statx", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int StatxUnix(
        int directoryDescriptor,
        string path,
        int flags,
        uint mask,
        out LinuxFileStatus output);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "fchmod", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int ChangeModeUnix(int descriptor, uint mode);

    [LibraryImport(LogBrew.DurableUnixNative.LibraryName, EntryPoint = "flock", SetLastError = true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
    private static partial int LockUnix(int descriptor, int operation);

    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxFileStatus
    {
        [FieldOffset(16)]
        internal uint LinkCount;

        [FieldOffset(28)]
        internal ushort Mode;
    }
}
