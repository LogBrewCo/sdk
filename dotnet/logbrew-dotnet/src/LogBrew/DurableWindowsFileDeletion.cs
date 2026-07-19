#if NET8_0_OR_GREATER
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace LogBrew
{
    internal sealed partial class DurableStoreFileSystem
    {
        private const int WindowsFileDispositionInfoEx = 21;
        private const uint WindowsFileDispositionDelete = 1;
        private const uint WindowsFileDispositionPosixSemantics = 2;

        private static uint WindowsDeleteAccess()
        {
            return WindowsGenericRead | WindowsDelete;
        }

        private static uint WindowsDeleteFlags()
        {
            return WindowsOpenReparsePoint;
        }

        private static int WindowsDeleteInformationClass()
        {
            return WindowsFileDispositionInfoEx;
        }

        private static uint WindowsDeleteInformationFlags()
        {
            return WindowsFileDispositionDelete | WindowsFileDispositionPosixSemantics;
        }

        private static int WindowsDeleteInformationSize()
        {
            return sizeof(uint);
        }

        private static bool IsWindowsMissingRecordError(int error)
        {
            return error == 2 || error == 3;
        }

        private static void RequireWindowsRecordMissing(string path)
        {
            using var reopened = CreateFileWindows(
                path,
                WindowsGenericRead,
                WindowsRecordShareMode(allowDelete: true, allowWrite: false),
                IntPtr.Zero,
                WindowsOpenExisting,
                WindowsOpenReparsePoint,
                IntPtr.Zero);
            if (!reopened.IsInvalid || !IsWindowsMissingRecordError(Marshal.GetLastPInvokeError()))
            {
                throw StorageUnavailable();
            }
        }

        private static void MarkWindowsRecordForDeletion(SafeFileHandle handle)
        {
            var flags = WindowsDeleteInformationFlags();
            if (!SetFileInformationByHandleWindowsDisposition(
                handle,
                WindowsDeleteInformationClass(),
                ref flags,
                checked((uint)WindowsDeleteInformationSize())))
            {
#if LOGBREW_TEST_HOOKS
                DurableStoreTestHooks.Reach(
                    "delete-mark-failed-win32-"
                    + Marshal.GetLastPInvokeError().ToString(System.Globalization.CultureInfo.InvariantCulture));
#endif
                throw StorageUnavailable();
            }
        }

        [LibraryImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SetFileInformationByHandleWindowsDisposition(
            SafeFileHandle handle,
            int informationClass,
            ref uint information,
            uint bufferSize);
    }
}
#endif
