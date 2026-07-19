#if NET8_0_OR_GREATER
using System;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

namespace LogBrew
{
    internal static class DurableUnixNative
    {
        internal const string LibraryName = "logbrew-unix-system";
        private static readonly string[] LinuxExports =
        {
            "open", "openat", "mkdirat", "flock", "fchmod", "linkat", "unlinkat", "renameat", "fsync", "statx",
        };
        private static readonly string[] MacOSArm64Exports =
        {
            "open", "openat", "mkdirat", "flock", "fchmod", "linkat", "unlinkat", "renameat", "fsync", "fstat",
        };
        private static readonly string[] MacOSX64Exports =
        {
            "open", "openat", "mkdirat", "flock", "fchmod", "linkat", "unlinkat", "renameat", "fsync", "fstat", "fstat$INODE64",
        };
        private static readonly Lazy<IntPtr> LibraryHandle = new(LoadAndRegister, LazyThreadSafetyMode.ExecutionAndPublication);
        private static IntPtr resolvedHandle;

        internal static bool IsAvailable()
        {
            return LibraryHandle.Value != IntPtr.Zero;
        }

        internal static string[] LibraryCandidates(string operatingSystem, Architecture architecture)
        {
            if (string.Equals(operatingSystem, "macos", StringComparison.Ordinal)
                && (architecture == Architecture.X64 || architecture == Architecture.Arm64))
            {
                return new[] { "libSystem.B.dylib" };
            }

            if (!string.Equals(operatingSystem, "linux", StringComparison.Ordinal))
            {
                return Array.Empty<string>();
            }

            return architecture switch
            {
                Architecture.X64 => new[] { "libc.so.6", "libc.musl-x86_64.so.1", "ld-musl-x86_64.so.1" },
                Architecture.Arm64 => new[] { "libc.so.6", "libc.musl-aarch64.so.1", "ld-musl-aarch64.so.1" },
                _ => Array.Empty<string>(),
            };
        }

        internal static string[] RequiredExports(string operatingSystem, Architecture architecture)
        {
            if (string.Equals(operatingSystem, "linux", StringComparison.Ordinal)
                && (architecture == Architecture.X64 || architecture == Architecture.Arm64))
            {
                return (string[])LinuxExports.Clone();
            }

            if (!string.Equals(operatingSystem, "macos", StringComparison.Ordinal))
            {
                return Array.Empty<string>();
            }

            return architecture switch
            {
                Architecture.X64 => (string[])MacOSX64Exports.Clone(),
                Architecture.Arm64 => (string[])MacOSArm64Exports.Clone(),
                _ => Array.Empty<string>(),
            };
        }

        private static IntPtr LoadAndRegister()
        {
            var operatingSystem = OperatingSystem.IsLinux()
                ? "linux"
                : OperatingSystem.IsMacOS()
                    ? "macos"
                    : "unsupported";
            var assembly = typeof(DurableUnixNative).Assembly;
            var architecture = RuntimeInformation.ProcessArchitecture;
            var requiredExports = RequiredExports(operatingSystem, architecture);
            foreach (var candidate in LibraryCandidates(operatingSystem, architecture))
            {
                if (!NativeLibrary.TryLoad(candidate, assembly, DllImportSearchPath.SafeDirectories, out var handle))
                {
                    continue;
                }

                if (!HasRequiredExports(handle, requiredExports))
                {
                    NativeLibrary.Free(handle);
                    continue;
                }

                try
                {
                    Volatile.Write(ref resolvedHandle, handle);
                    NativeLibrary.SetDllImportResolver(assembly, Resolve);
                    return handle;
                }
                catch (ArgumentException)
                {
                    return ReleaseFailedRegistration(handle);
                }
                catch (InvalidOperationException)
                {
                    return ReleaseFailedRegistration(handle);
                }
            }

            return IntPtr.Zero;
        }

        private static bool HasRequiredExports(IntPtr handle, string[] requiredExports)
        {
            foreach (var export in requiredExports)
            {
                if (!NativeLibrary.TryGetExport(handle, export, out _))
                {
                    return false;
                }
            }

            return requiredExports.Length > 0;
        }

        private static IntPtr ReleaseFailedRegistration(IntPtr handle)
        {
            Volatile.Write(ref resolvedHandle, IntPtr.Zero);
            NativeLibrary.Free(handle);
            return IntPtr.Zero;
        }

        private static IntPtr Resolve(string libraryName, Assembly assembly, DllImportSearchPath? searchPath)
        {
            _ = assembly;
            _ = searchPath;
            return string.Equals(libraryName, LibraryName, StringComparison.Ordinal)
                ? Volatile.Read(ref resolvedHandle)
                : IntPtr.Zero;
        }
    }
}
#endif
