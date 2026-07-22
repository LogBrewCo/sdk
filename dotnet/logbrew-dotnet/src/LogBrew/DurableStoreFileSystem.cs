#if NET8_0_OR_GREATER
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace LogBrew
{
    internal sealed partial class DurableStoreFileSystem : IDisposable
    {
        internal const string OwnerFileName = ".owner";
        private const string ChildDirectoryName = ".logbrew-delivery-v1";
        private const int LockExclusiveNonBlocking = 6;
        private const int UnixWriteOnly = 1;
        private const int UnixReadWrite = 2;
        private const int LinuxCreate = 0x40;
        private const int LinuxExclusive = 0x80;
        private const int LinuxX64Directory = 0x10000;
        private const int LinuxX64NoFollow = 0x20000;
        private const int LinuxArm64Directory = 0x4000;
        private const int LinuxArm64NoFollow = 0x8000;
        private const int LinuxCloseOnExec = 0x80000;
        private const int MacOSCreate = 0x200;
        private const int MacOSExclusive = 0x800;
        private const int MacOSNoFollow = 0x100;
        private const int MacOSDirectory = 0x100000;
        private const int MacOSCloseOnExec = 0x1000000;
        private const uint WindowsGenericRead = 0x80000000;
        private const uint WindowsGenericWrite = 0x40000000;
        private const uint WindowsReadControl = 0x00020000;
        private const uint WindowsDelete = 0x00010000;
        private const uint WindowsShareRead = 1;
        private const uint WindowsShareWrite = 2;
        private const uint WindowsShareDelete = 4;
        private const uint WindowsOpenExisting = 3;
        private const uint WindowsBackupSemantics = 0x02000000;
        private const uint WindowsOpenReparsePoint = 0x00200000;
        private const uint WindowsWriteThrough = 0x80000000;
        private const uint WindowsCreateNew = 1;
        private const uint WindowsMoveWriteThrough = 8;
        private const int MaximumPurgeEntries = 4096;
        private readonly string parentPath;
        private readonly string childPath;
        private readonly SafeFileHandle parentHandle;
        private readonly SafeFileHandle childHandle;
        private readonly SafeFileHandle ownerHandle;
        private readonly DurableFileIdentity parentIdentity;
        private readonly DurableFileIdentity childIdentity;
        private readonly DurableFileIdentity ownerIdentity;
        private bool disposed;

        private DurableStoreFileSystem(
            string parentPath,
            string childPath,
            SafeFileHandle parentHandle,
            SafeFileHandle childHandle,
            SafeFileHandle ownerHandle)
        {
            this.parentPath = parentPath;
            this.childPath = childPath;
            this.parentHandle = parentHandle;
            this.childHandle = childHandle;
            this.ownerHandle = ownerHandle;
            parentIdentity = RequireDirectory(parentHandle);
            childIdentity = RequirePrivateDirectory(childHandle);
            ownerIdentity = RequirePrivateSingleLinkFile(ownerHandle);
        }

        internal static DurableStoreFileSystem Open(string parentPath)
        {
            var parentHandle = new SafeFileHandle(IntPtr.Zero, ownsHandle: true);
            var childHandle = new SafeFileHandle(IntPtr.Zero, ownsHandle: true);
            var ownerHandle = new SafeFileHandle(IntPtr.Zero, ownsHandle: true);
            var ownsResources = false;
            try
            {
                var childPath = Path.Combine(parentPath, ChildDirectoryName);
                parentHandle = OpenDirectory(parentPath);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-parent-opened");
#endif
                childHandle = OpenOrCreateChildDirectory(parentHandle, childPath);
                RequirePrivateDirectory(childHandle);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-child-opened");
#endif
                ownerHandle = OpenAndLockOwner(childHandle, Path.Combine(childPath, OwnerFileName));
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-owner-opened");
#endif
                var fileSystem = new DurableStoreFileSystem(parentPath, childPath, parentHandle, childHandle, ownerHandle);
                fileSystem.ValidateOwnership();
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-ownership-validated");
#endif
                ownsResources = true;
                return fileSystem;
            }
            catch (Exception error) when (!DeliveryExceptionPolicy.IsFatal(error))
            {
                throw error is SdkException ? error : StorageUnavailable();
            }
            finally
            {
                if (!ownsResources)
                {
                    ownerHandle.Dispose();
                    childHandle.Dispose();
                    parentHandle.Dispose();
                }
            }
        }

        internal void ValidateOwnership()
        {
            RequireNotDisposed();
            using var currentParent = OpenDirectory(parentPath);
            RequireIdentity(currentParent, parentIdentity, requireSingleLink: false);
            using var currentChild = OpenExistingChildDirectory(currentParent, childPath);
            RequireIdentity(currentChild, childIdentity, requireSingleLink: false);
            RequirePrivateDirectory(currentChild);
            RequireIdentity(ownerHandle, ownerIdentity, requireSingleLink: true);
            RequirePrivateSingleLinkFile(ownerHandle);
            if (!OperatingSystem.IsWindows())
            {
                using var currentOwner = OpenExistingOwner(currentChild, Path.Combine(childPath, OwnerFileName));
                RequireIdentity(currentOwner, ownerIdentity, requireSingleLink: true);
                RequirePrivateSingleLinkFile(currentOwner);
            }
        }

        internal IReadOnlyList<DurableFileEntry> EnumerateEntries(long maximumEntries, long maximumBytes)
        {
            ValidateOwnership();
            var entries = new List<DurableFileEntry>();
            long totalBytes = 0;
            foreach (var path in Directory.EnumerateFileSystemEntries(childPath))
            {
                var name = Path.GetFileName(path);
                if (string.Equals(name, OwnerFileName, StringComparison.Ordinal))
                {
                    continue;
                }

                using var stream = OpenExistingRecord(name);
                var identity = RequirePrivateSingleLinkFile(stream.SafeFileHandle);
                var length = stream.Length;
                RequireIdentity(stream.SafeFileHandle, identity, requireSingleLink: true);
                if (entries.Count == maximumEntries || length < 0 || length > maximumBytes - totalBytes)
                {
                    throw StorageUnavailable();
                }

                totalBytes += length;
                entries.Add(new DurableFileEntry(name, length));
            }

            ValidateOwnership();
            return entries;
        }

        internal void Purge()
        {
            ValidateOwnership();
            var deleted = 0;
            foreach (var path in Directory.EnumerateFileSystemEntries(childPath))
            {
                var name = Path.GetFileName(path);
                if (string.Equals(name, OwnerFileName, StringComparison.Ordinal))
                {
                    continue;
                }

                if (deleted == MaximumPurgeEntries)
                {
                    throw StorageUnavailable();
                }

                Delete(name, allowMissing: false);
                deleted++;
            }

            FlushDirectory();
            ValidateOwnership();
        }

        internal byte[] ReadRecord(string recordName, int maximumBytes)
        {
            ValidateOwnership();
            using var stream = OpenExistingRecord(recordName);
            var identity = RequirePrivateSingleLinkFile(stream.SafeFileHandle);
            if (stream.Length <= 0 || stream.Length > maximumBytes)
            {
                throw StorageUnavailable();
            }

            var bytes = new byte[checked((int)stream.Length)];
            var offset = 0;
            while (offset < bytes.Length)
            {
                var read = stream.Read(bytes, offset, bytes.Length - offset);
                if (read == 0)
                {
                    Array.Clear(bytes, 0, bytes.Length);
                    throw StorageUnavailable();
                }

                offset += read;
            }

            RequireIdentity(stream.SafeFileHandle, identity, requireSingleLink: true);
            ValidateOwnership();
            return bytes;
        }

        internal void Publish(string recordName, byte[] record)
        {
            var temporaryName = ".tmp-" + Guid.NewGuid().ToString("N");
            using var temporary = CreateNewRecordFile(temporaryName);
            var temporaryIdentity = RequireSingleLinkFile(temporary.SafeFileHandle);
            temporary.Write(record, 0, record.Length);
            temporary.Flush(flushToDisk: true);
            RequireIdentity(temporary.SafeFileHandle, temporaryIdentity, requireSingleLink: true);
            PublishWithoutReplacement(temporaryName, recordName);
            using var published = OpenExistingRecord(recordName, allowWrite: true);
            RequireIdentity(published.SafeFileHandle, temporaryIdentity, requireSingleLink: true);
            ValidateOwnership();
        }

        internal void Replace(string recordName, byte[] record)
        {
            var temporaryName = ".tmp-" + Guid.NewGuid().ToString("N");
            using var temporary = CreateNewReplacementFile(temporaryName);
            var temporaryIdentity = RequireSingleLinkFile(temporary.SafeFileHandle);
            temporary.Write(record, 0, record.Length);
            temporary.Flush(flushToDisk: true);
            RequireIdentity(temporary.SafeFileHandle, temporaryIdentity, requireSingleLink: true);
            using var existing = OpenExistingRecord(recordName, allowDelete: true);
            RequirePrivateSingleLinkFile(existing.SafeFileHandle);
            ValidateOwnership();
            if (OperatingSystem.IsWindows())
            {
                ReplaceWindows(temporary.SafeFileHandle, recordName);
                temporary.Flush(flushToDisk: true);
            }
            else if (RenameAtUnix(Descriptor(childHandle), temporaryName, Descriptor(childHandle), recordName) != 0)
            {
                throw StorageUnavailable();
            }

            FlushDirectory();
            using var published = OpenExistingRecord(recordName, allowDelete: true, allowWrite: true);
            RequireIdentity(published.SafeFileHandle, temporaryIdentity, requireSingleLink: true);
            ValidateOwnership();
        }

        internal void Delete(string recordName, bool allowMissing)
        {
            if (OperatingSystem.IsWindows())
            {
                var path = Path.Combine(childPath, recordName);
                var handle = CreateFileWindows(
                    path,
                    WindowsDeleteAccess(),
                    WindowsShareRead | WindowsShareDelete,
                    IntPtr.Zero,
                    WindowsOpenExisting,
                    WindowsDeleteFlags(),
                    IntPtr.Zero);
                if (handle.IsInvalid)
                {
                    handle.Dispose();
                    var error = Marshal.GetLastPInvokeError();
                    if (allowMissing && IsWindowsMissingRecordError(error))
                    {
                        return;
                    }

                    throw StorageUnavailable();
                }

                using (handle)
                {
                    var identity = RequirePrivateSingleLinkFile(handle);
                    RequireIdentity(handle, identity, requireSingleLink: true);
                    MarkWindowsRecordForDeletion(handle);
                }

                RequireWindowsRecordMissing(path);
                return;
            }

            var descriptor = OpenAtUnix(Descriptor(childHandle), recordName, UnixNoFollowCloseOnExecFlags());
            if (descriptor < 0)
            {
                if (allowMissing && Marshal.GetLastPInvokeError() == 2)
                {
                    return;
                }

                throw StorageUnavailable();
            }

            using var handleUnix = new SafeFileHandle((IntPtr)descriptor, ownsHandle: true);
            var identityUnix = RequirePrivateSingleLinkFile(handleUnix);
            if (UnlinkAtUnix(Descriptor(childHandle), recordName, 0) != 0)
            {
                throw StorageUnavailable();
            }

            RequireUnlinkedIdentity(handleUnix, identityUnix);
        }

        internal void FlushDirectory()
        {
            if (!OperatingSystem.IsWindows() && SyncUnix(Descriptor(childHandle)) != 0)
            {
                throw StorageUnavailable();
            }
        }

        public void Dispose()
        {
            if (!disposed)
            {
                ownerHandle.Dispose();
                childHandle.Dispose();
                parentHandle.Dispose();
                disposed = true;
            }
        }

        private FileStream CreateNewRecordFile(string name)
        {
            return CreateNewRecordFile(name, WindowsRecordCreationAccess());
        }

        private FileStream CreateNewRecordFile(string name, uint windowsAccess)
        {
            SafeFileHandle handle;
            if (OperatingSystem.IsWindows())
            {
                handle = RequireValid(DurableWindowsAccessControl.CreateOwnerOnlyFile(
                    Path.Combine(childPath, name),
                    windowsAccess,
                    WindowsShareRead | WindowsShareDelete,
                    WindowsCreateNew,
                    WindowsOpenReparsePoint | WindowsWriteThrough));
                try
                {
                    RequirePrivateSingleLinkFile(handle);
                }
                catch
                {
                    handle.Dispose();
                    throw;
                }
            }
            else
            {
                handle = RequireValid(new SafeFileHandle(
                    (IntPtr)OpenAtCreateUnix(Descriptor(childHandle), name, UnixNewFileFlags(), Convert.ToUInt32("600", 8)),
                    ownsHandle: true));
                if (ChangeModeUnix(Descriptor(handle), Convert.ToUInt32("600", 8)) != 0)
                {
                    handle.Dispose();
                    throw StorageUnavailable();
                }
            }

            return new FileStream(handle, FileAccess.Write, bufferSize: 4096, isAsync: false);
        }

        private FileStream OpenExistingRecord(string name, bool allowDelete = false, bool allowWrite = false)
        {
            SafeFileHandle handle;
            if (OperatingSystem.IsWindows())
            {
                handle = RequireValid(CreateFileWindows(
                    Path.Combine(childPath, name),
                    WindowsGenericRead,
                    WindowsRecordShareMode(allowDelete, allowWrite),
                    IntPtr.Zero,
                    WindowsOpenExisting,
                    WindowsOpenReparsePoint,
                    IntPtr.Zero));
            }
            else
            {
                handle = RequireValid(new SafeFileHandle(
                    (IntPtr)OpenAtUnix(Descriptor(childHandle), name, UnixNoFollowCloseOnExecFlags()),
                    ownsHandle: true));
            }

            return new FileStream(handle, FileAccess.Read, bufferSize: 4096, isAsync: false);
        }

        private static uint WindowsRecordShareMode(bool allowDelete, bool allowWrite)
        {
            return WindowsShareRead
                | (allowDelete ? WindowsShareDelete : 0)
                | (allowWrite ? WindowsShareWrite : 0);
        }

        private void PublishWithoutReplacement(string temporaryName, string recordName)
        {
            if (OperatingSystem.IsWindows())
            {
                if (!MoveFileWindows(
                    Path.Combine(childPath, temporaryName),
                    Path.Combine(childPath, recordName),
                    WindowsMoveWriteThrough))
                {
                    throw StorageUnavailable();
                }

                FlushDirectory();
                return;
            }

            if (LinkAtUnix(Descriptor(childHandle), temporaryName, Descriptor(childHandle), recordName, 0) != 0)
            {
                throw StorageUnavailable();
            }

            if (UnlinkAtUnix(Descriptor(childHandle), temporaryName, 0) != 0)
            {
                throw StorageUnavailable();
            }

            FlushDirectory();
        }

        private static SafeFileHandle OpenDirectory(string path, uint windowsAccess = WindowsGenericRead)
        {
            if (OperatingSystem.IsWindows())
            {
                return RequireValid(CreateFileWindows(
                    path,
                    windowsAccess,
                    WindowsShareRead | WindowsShareWrite,
                    IntPtr.Zero,
                    WindowsOpenExisting,
                    WindowsBackupSemantics | WindowsOpenReparsePoint,
                    IntPtr.Zero));
            }

            return RequireValid(new SafeFileHandle((IntPtr)OpenUnix(path, UnixDirectoryFlags()), ownsHandle: true));
        }

        private static SafeFileHandle OpenOrCreateChildDirectory(SafeFileHandle parent, string childPath)
        {
            if (OperatingSystem.IsWindows())
            {
                _ = DurableWindowsAccessControl.CreateDirectory(childPath);
                var handle = OpenDirectory(childPath, WindowsReadControl);
                try
                {
                    RequireDirectory(handle);
                    DurableWindowsAccessControl.RequireOwnerOnly(handle, requireProtected: true);
                    return handle;
                }
                catch
                {
                    handle.Dispose();
                    throw;
                }
            }

            var descriptor = Descriptor(parent);
            if (MakeDirectoryAtUnix(descriptor, ChildDirectoryName, Convert.ToUInt32("700", 8)) != 0
                && Marshal.GetLastPInvokeError() != 17)
            {
                throw StorageUnavailable();
            }

            return RequireValid(new SafeFileHandle(
                (IntPtr)OpenAtUnix(descriptor, ChildDirectoryName, UnixDirectoryFlags()),
                ownsHandle: true));
        }

        private static SafeFileHandle OpenExistingChildDirectory(SafeFileHandle parent, string childPath)
        {
            return OperatingSystem.IsWindows()
                ? OpenDirectory(childPath)
                : RequireValid(new SafeFileHandle(
                    (IntPtr)OpenAtUnix(Descriptor(parent), ChildDirectoryName, UnixDirectoryFlags()),
                    ownsHandle: true));
        }

        private static SafeFileHandle OpenAndLockOwner(SafeFileHandle child, string ownerPath)
        {
            if (OperatingSystem.IsWindows())
            {
                var owner = DurableWindowsAccessControl.CreateOwnerOnlyFile(
                    ownerPath,
                    WindowsGenericRead | WindowsGenericWrite,
                    0,
                    4,
                    WindowsOpenReparsePoint | WindowsWriteThrough);
#if LOGBREW_TEST_HOOKS
                if (owner.IsInvalid)
                {
                    DurableStoreTestHooks.Reach(
                        "store-owner-handle-open-failed-win32-"
                        + Marshal.GetLastPInvokeError().ToString(System.Globalization.CultureInfo.InvariantCulture));
                }
#endif
                owner = RequireValid(owner);
                return LockAndValidateOwner(owner);
            }

            var descriptor = OpenAtCreateUnix(
                Descriptor(child),
                OwnerFileName,
                UnixOwnerCreateFlags(),
                Convert.ToUInt32("600", 8));
            if (descriptor >= 0)
            {
                return LockAndValidateOwner(new SafeFileHandle((IntPtr)descriptor, ownsHandle: true), created: true);
            }

            if (Marshal.GetLastPInvokeError() != 17)
            {
                throw StorageUnavailable();
            }

            return LockAndValidateOwner(RequireValid(new SafeFileHandle(
                (IntPtr)OpenAtUnix(Descriptor(child), OwnerFileName, UnixOwnerExistingFlags()),
                ownsHandle: true)));
        }

        private static SafeFileHandle LockAndValidateOwner(SafeFileHandle owner, bool created = false)
        {
            try
            {
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-owner-handle-opened");
                _ = RequireSingleLinkFile(owner);
                DurableStoreTestHooks.Reach("store-owner-identity-validated");
#endif
                var identity = created ? RequireSingleLinkFile(owner) : RequirePrivateSingleLinkFile(owner);
                if (created)
                {
                    if (ChangeModeUnix(Descriptor(owner), Convert.ToUInt32("600", 8)) != 0)
                    {
                        throw StorageUnavailable();
                    }

                    RequireIdentity(owner, identity, requireSingleLink: true);
                    RequirePrivateSingleLinkFile(owner);
                }
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-owner-security-validated");
#endif

                if (!OperatingSystem.IsWindows() && LockUnix(Descriptor(owner), LockExclusiveNonBlocking) != 0)
                {
                    throw StorageUnavailable();
                }

                RequireIdentity(owner, identity, requireSingleLink: true);
                RequirePrivateSingleLinkFile(owner);
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach("store-owner-identity-revalidated");
#endif
                return owner;
            }
            catch
            {
                owner.Dispose();
                throw;
            }
        }

        private static SafeFileHandle OpenExistingOwner(SafeFileHandle child, string ownerPath)
        {
            return OperatingSystem.IsWindows()
                ? RequireValid(CreateFileWindows(
                    ownerPath,
                    WindowsGenericRead,
                    WindowsShareRead | WindowsShareWrite,
                    IntPtr.Zero,
                    WindowsOpenExisting,
                    WindowsOpenReparsePoint,
                    IntPtr.Zero))
                : RequireValid(new SafeFileHandle(
                    (IntPtr)OpenAtUnix(Descriptor(child), OwnerFileName, UnixOwnerExistingFlags()),
                    ownsHandle: true));
        }

        private static DurableFileIdentity RequireDirectory(SafeFileHandle handle)
        {
            var identity = DurableFileIdentityReader.Read(handle);
            if (!identity.IsDirectory || identity.IsLink)
            {
                throw StorageUnavailable();
            }

            return identity;
        }

        private static DurableFileIdentity RequirePrivateDirectory(SafeFileHandle handle)
        {
            var identity = RequireDirectory(handle);
            if (OperatingSystem.IsWindows())
            {
                DurableWindowsAccessControl.RequireOwnerOnly(handle, requireProtected: true);
            }
            else if (identity.UnixPermissions != Convert.ToUInt32("700", 8))
            {
                throw StorageUnavailable();
            }

            return identity;
        }

        private static DurableFileIdentity RequireSingleLinkFile(SafeFileHandle handle)
        {
            var identity = DurableFileIdentityReader.Read(handle);
            if (identity.IsDirectory || identity.IsLink || identity.LinkCount != 1)
            {
                throw StorageUnavailable();
            }

            return identity;
        }

        private static DurableFileIdentity RequirePrivateSingleLinkFile(SafeFileHandle handle)
        {
            var identity = RequireSingleLinkFile(handle);
            if (OperatingSystem.IsWindows())
            {
                DurableWindowsAccessControl.RequireOwnerOnly(handle, requireProtected: false);
            }
            else if (identity.UnixPermissions != Convert.ToUInt32("600", 8))
            {
                throw StorageUnavailable();
            }

            return identity;
        }

        private static void RequireIdentity(SafeFileHandle handle, DurableFileIdentity expected, bool requireSingleLink)
        {
            var actual = DurableFileIdentityReader.Read(handle);
            if (actual.IsLink || !actual.Equals(expected) || (requireSingleLink && actual.LinkCount != 1))
            {
                throw StorageUnavailable();
            }
        }

        private static void RequireUnlinkedIdentity(SafeFileHandle handle, DurableFileIdentity expected)
        {
            var actual = DurableFileIdentityReader.Read(handle);
            if (actual.IsLink || !actual.Equals(expected) || actual.LinkCount != 0)
            {
                throw StorageUnavailable();
            }
        }

        private static SafeFileHandle RequireValid(SafeFileHandle handle)
        {
            if (handle.IsInvalid)
            {
                handle.Dispose();
                throw StorageUnavailable();
            }

            return handle;
        }

        private static int Descriptor(SafeFileHandle handle)
        {
            return checked((int)handle.DangerousGetHandle());
        }

        private static int UnixDirectoryFlags()
        {
            return OperatingSystem.IsLinux()
                ? LinuxDirectoryFlag(RuntimeInformation.ProcessArchitecture)
                    | LinuxNoFollowCloseOnExecFlags()
                : MacOSDirectory | MacOSNoFollow | MacOSCloseOnExec;
        }

        private static int UnixOwnerCreateFlags()
        {
            return UnixReadWrite | (OperatingSystem.IsLinux()
                ? LinuxCreate | LinuxExclusive | LinuxNoFollowCloseOnExecFlags()
                : MacOSCreate | MacOSExclusive | MacOSNoFollow | MacOSCloseOnExec);
        }

        private static int UnixOwnerExistingFlags()
        {
            return UnixReadWrite | (OperatingSystem.IsLinux()
                ? LinuxNoFollowCloseOnExecFlags()
                : MacOSNoFollow | MacOSCloseOnExec);
        }

        private static int UnixNewFileFlags()
        {
            return UnixWriteOnly | (OperatingSystem.IsLinux()
                ? LinuxCreate | LinuxExclusive | LinuxNoFollowCloseOnExecFlags()
                : MacOSCreate | MacOSExclusive | MacOSNoFollow | MacOSCloseOnExec);
        }

        private static int UnixNoFollowCloseOnExecFlags()
        {
            return OperatingSystem.IsLinux()
                ? LinuxNoFollowCloseOnExecFlags()
                : MacOSNoFollow | MacOSCloseOnExec;
        }

        private static int LinuxNoFollowCloseOnExecFlags()
        {
            return LinuxNoFollowFlag(RuntimeInformation.ProcessArchitecture) | LinuxCloseOnExec;
        }

        private static int LinuxDirectoryFlag(Architecture architecture)
        {
            return architecture switch
            {
                Architecture.X64 => LinuxX64Directory,
                Architecture.Arm64 => LinuxArm64Directory,
                _ => throw StorageUnavailable(),
            };
        }

        private static int LinuxNoFollowFlag(Architecture architecture)
        {
            return architecture switch
            {
                Architecture.X64 => LinuxX64NoFollow,
                Architecture.Arm64 => LinuxArm64NoFollow,
                _ => throw StorageUnavailable(),
            };
        }

        private void RequireNotDisposed()
        {
            if (disposed)
            {
                throw StorageUnavailable();
            }
        }

        private static SdkException StorageUnavailable()
        {
            return new SdkException("storage_error", "durable delivery storage is unavailable");
        }

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "open", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int OpenUnix(string path, int flags);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int OpenAtUnix(int directoryDescriptor, string path, int flags);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "openat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int OpenAtCreateUnix(int directoryDescriptor, string path, int flags, uint mode);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "mkdirat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int MakeDirectoryAtUnix(int directoryDescriptor, string path, uint mode);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "flock", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int LockUnix(int descriptor, int operation);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "fchmod", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int ChangeModeUnix(int descriptor, uint mode);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "linkat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int LinkAtUnix(int oldDirectoryDescriptor, string oldPath, int newDirectoryDescriptor, string newPath, int flags);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "unlinkat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int UnlinkAtUnix(int directoryDescriptor, string path, int flags);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "renameat", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int RenameAtUnix(int oldDirectoryDescriptor, string oldPath, int newDirectoryDescriptor, string newPath);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "fsync", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int SyncUnix(int descriptor);

        [LibraryImport("kernel32.dll", EntryPoint = "CreateFileW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static partial SafeFileHandle CreateFileWindows(
            string path,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [LibraryImport("kernel32.dll", EntryPoint = "MoveFileExW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool MoveFileWindows(string existingPath, string newPath, uint flags);

    }

    internal sealed class DurableFileEntry
    {
        internal DurableFileEntry(string name, long length)
        {
            Name = name;
            Length = length;
        }

        internal string Name { get; }

        internal long Length { get; }
    }
}
#endif
