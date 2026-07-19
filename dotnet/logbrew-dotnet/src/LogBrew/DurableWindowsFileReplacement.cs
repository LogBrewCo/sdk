#if NET8_0_OR_GREATER
using System;
using System.Buffers.Binary;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace LogBrew
{
    internal sealed partial class DurableStoreFileSystem
    {
        private const int WindowsFileRenameInfoEx = 22;
        private const uint WindowsFileRenameReplaceIfExists = 1;
        private const uint WindowsFileRenamePosixSemantics = 2;

        private static uint WindowsRecordCreationAccess()
        {
            return WindowsGenericRead | WindowsGenericWrite;
        }

        private static uint WindowsReplacementAccess()
        {
            return WindowsGenericRead | WindowsGenericWrite | WindowsDelete;
        }

        private FileStream CreateNewReplacementFile(string name)
        {
            return CreateNewRecordFile(name, WindowsReplacementAccess());
        }

        private static int WindowsReplacementInformationClass()
        {
            return WindowsFileRenameInfoEx;
        }

        private static uint WindowsReplacementFlags()
        {
            return WindowsFileRenameReplaceIfExists | WindowsFileRenamePosixSemantics;
        }

        private static int WindowsReplacementFileNameOffset()
        {
            return IntPtr.Size == 8 ? 20 : 12;
        }

        private void ReplaceWindows(SafeFileHandle source, string recordName)
        {
            var targetName = Encoding.Unicode.GetBytes(Path.Combine(childPath, recordName));
            var fileNameOffset = WindowsReplacementFileNameOffset();
            var information = new byte[checked(fileNameOffset + targetName.Length)];
            BinaryPrimitives.WriteUInt32LittleEndian(information.AsSpan(0, sizeof(uint)), WindowsReplacementFlags());
            BinaryPrimitives.WriteInt32LittleEndian(
                information.AsSpan(fileNameOffset - sizeof(int), sizeof(int)),
                targetName.Length);
            targetName.CopyTo(information.AsSpan(fileNameOffset));

            var pinned = GCHandle.Alloc(information, GCHandleType.Pinned);
            try
            {
                if (!SetFileInformationByHandleWindowsBuffer(
                    source,
                    WindowsReplacementInformationClass(),
                    pinned.AddrOfPinnedObject(),
                    checked((uint)information.Length)))
                {
#if LOGBREW_TEST_HOOKS
                    DurableStoreTestHooks.Reach(
                        "replace-failed-win32-"
                        + Marshal.GetLastPInvokeError().ToString(System.Globalization.CultureInfo.InvariantCulture));
#endif
                    throw StorageUnavailable();
                }
            }
            finally
            {
                Array.Clear(information, 0, information.Length);
                pinned.Free();
            }
        }

        [LibraryImport("kernel32.dll", EntryPoint = "SetFileInformationByHandle", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool SetFileInformationByHandleWindowsBuffer(
            SafeFileHandle handle,
            int informationClass,
            IntPtr information,
            uint bufferSize);
    }
}
#endif
