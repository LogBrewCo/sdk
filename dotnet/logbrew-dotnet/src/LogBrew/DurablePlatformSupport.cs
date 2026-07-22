#if NET8_0_OR_GREATER
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace LogBrew
{
    internal static class DurablePlatformSupport
    {
        internal static bool IsSupported(string operatingSystem, Architecture architecture)
        {
            var supportedArchitecture = architecture == Architecture.X64 || architecture == Architecture.Arm64;
            return supportedArchitecture
                && (string.Equals(operatingSystem, "linux", StringComparison.Ordinal)
                    || string.Equals(operatingSystem, "macos", StringComparison.Ordinal)
                    || string.Equals(operatingSystem, "windows", StringComparison.Ordinal));
        }

        internal static void RequireCurrent()
        {
            var operatingSystem = OperatingSystem.IsLinux()
                ? "linux"
                : OperatingSystem.IsMacOS()
                    ? "macos"
                    : OperatingSystem.IsWindows()
                        ? "windows"
                        : "unsupported";
            if (!IsSupported(operatingSystem, RuntimeInformation.ProcessArchitecture))
            {
                throw new SdkException("configuration_error", "durable delivery is not supported on this platform");
            }

            if (OperatingSystem.IsWindows()
                && !OperatingSystem.IsWindowsVersionAtLeast(10, 0, WindowsMinimumBuild()))
            {
                throw new SdkException("configuration_error", "durable delivery is not supported on this Windows version");
            }

            if (!OperatingSystem.IsWindows() && !DurableUnixNative.IsAvailable())
            {
                throw new SdkException("storage_error", "durable delivery storage is unavailable");
            }
        }

        internal static int WindowsMinimumBuild()
        {
            return 16299;
        }
    }

    internal readonly struct DurableFileIdentity : IEquatable<DurableFileIdentity>
    {
        internal DurableFileIdentity(ulong device, ulong file, uint linkCount, bool isDirectory, bool isLink = false, uint unixPermissions = 0)
        {
            Device = device;
            File = file;
            LinkCount = linkCount;
            IsDirectory = isDirectory;
            IsLink = isLink;
            UnixPermissions = unixPermissions;
        }

        internal ulong Device { get; }

        internal ulong File { get; }

        internal uint LinkCount { get; }

        internal bool IsDirectory { get; }

        internal bool IsLink { get; }

        internal uint UnixPermissions { get; }

        public bool Equals(DurableFileIdentity other)
        {
            return Device == other.Device && File == other.File && IsDirectory == other.IsDirectory && IsLink == other.IsLink;
        }

        public override bool Equals(object? value)
        {
            return value is DurableFileIdentity other && Equals(other);
        }

        public override int GetHashCode()
        {
            return HashCode.Combine(Device, File, IsDirectory, IsLink);
        }
    }

    internal static partial class DurableFileIdentityReader
    {
        private const int UnixFileTypeMask = 0xF000;
        private const int UnixDirectory = 0x4000;
        private const uint WindowsDirectory = 0x10;
        private const uint WindowsReparsePoint = 0x400;
        private const int AtEmptyPath = 0x1000;
        private const int AtNoAutomount = 0x800;
        private const uint StatxBasicStats = 0x07ff;
        private const uint StatxMountId = 0x1000;

        internal static DurableFileIdentity Read(SafeFileHandle handle)
        {
            if (OperatingSystem.IsWindows())
            {
                return ReadWindows(handle);
            }

            var addedReference = false;
            try
            {
                handle.DangerousAddRef(ref addedReference);
                var descriptor = checked((int)handle.DangerousGetHandle());
                return OperatingSystem.IsLinux() ? ReadLinux(descriptor) : ReadMacOS(descriptor);
            }
            finally
            {
                if (addedReference)
                {
                    handle.DangerousRelease();
                }
            }
        }

        private static DurableFileIdentity ReadLinux(int descriptor)
        {
            if (LinuxStatx(
                descriptor,
                string.Empty,
                AtEmptyPath | AtNoAutomount,
                StatxBasicStats | StatxMountId,
                out var status) != 0)
            {
                throw StorageUnavailable();
            }

            var device = ((ulong)status.DeviceMajor << 32) | status.DeviceMinor;
            return new DurableFileIdentity(
                device,
                status.Inode,
                status.LinkCount,
                (status.Mode & UnixFileTypeMask) == UnixDirectory,
                unixPermissions: (uint)(status.Mode & 0x01ff));
        }

        private static DurableFileIdentity ReadMacOS(int descriptor)
        {
            var result = RuntimeInformation.ProcessArchitecture == Architecture.X64
                ? MacOSFStatInode64(descriptor, out var status)
                : MacOSFStat(descriptor, out status);
            if (result != 0)
            {
                throw StorageUnavailable();
            }

            return new DurableFileIdentity(
                unchecked((uint)status.Device),
                status.Inode,
                status.LinkCount,
                (status.Mode & UnixFileTypeMask) == UnixDirectory,
                unixPermissions: (uint)(status.Mode & 0x01ff));
        }

        private static DurableFileIdentity ReadWindows(SafeFileHandle handle)
        {
            if (!GetFileInformationByHandle(handle, out var information))
            {
                throw StorageUnavailable();
            }

            return new DurableFileIdentity(
                information.VolumeSerialNumber,
                ((ulong)information.FileIndexHigh << 32) | information.FileIndexLow,
                information.NumberOfLinks,
                (information.FileAttributes & WindowsDirectory) != 0,
                (information.FileAttributes & WindowsReparsePoint) != 0);
        }

        private static SdkException StorageUnavailable()
        {
            return new SdkException("storage_error", "durable delivery storage is unavailable");
        }

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "statx", SetLastError = true, StringMarshalling = StringMarshalling.Utf8)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int LinuxStatx(int directoryDescriptor, string path, int flags, uint mask, out LinuxFileStatus output);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "fstat", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int MacOSFStat(int descriptor, out MacOSFileStatus output);

        [LibraryImport(DurableUnixNative.LibraryName, EntryPoint = "fstat$INODE64", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.SafeDirectories)]
        private static partial int MacOSFStatInode64(int descriptor, out MacOSFileStatus output);

        [LibraryImport("kernel32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool GetFileInformationByHandle(SafeFileHandle handle, out WindowsFileInformation output);

        [StructLayout(LayoutKind.Explicit, Size = 256)]
        private struct LinuxFileStatus
        {
            [FieldOffset(16)]
            internal uint LinkCount;

            [FieldOffset(28)]
            internal ushort Mode;

            [FieldOffset(32)]
            internal ulong Inode;

            [FieldOffset(136)]
            internal uint DeviceMajor;

            [FieldOffset(140)]
            internal uint DeviceMinor;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MacOSFileStatus
        {
            internal int Device;
            internal ushort Mode;
            internal ushort LinkCount;
            internal ulong Inode;
            internal uint UserId;
            internal uint GroupId;
            internal int RawDevice;
            internal long AccessTimeSeconds;
            internal long AccessTimeNanoseconds;
            internal long ModificationTimeSeconds;
            internal long ModificationTimeNanoseconds;
            internal long ChangeTimeSeconds;
            internal long ChangeTimeNanoseconds;
            internal long BirthTimeSeconds;
            internal long BirthTimeNanoseconds;
            internal long Size;
            internal long Blocks;
            internal int BlockSize;
            internal uint Flags;
            internal uint Generation;
            internal int Spare;
            internal long SpareOne;
            internal long SpareTwo;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowsFileTime
        {
            internal uint Low;
            internal uint High;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowsFileInformation
        {
            internal uint FileAttributes;
            internal WindowsFileTime CreationTime;
            internal WindowsFileTime LastAccessTime;
            internal WindowsFileTime LastWriteTime;
            internal uint VolumeSerialNumber;
            internal uint FileSizeHigh;
            internal uint FileSizeLow;
            internal uint NumberOfLinks;
            internal uint FileIndexHigh;
            internal uint FileIndexLow;
        }
    }
}
#endif
