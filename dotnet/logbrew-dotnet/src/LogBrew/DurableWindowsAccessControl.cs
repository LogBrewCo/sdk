#if NET8_0_OR_GREATER
using System;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.AccessControl;
using System.Security.Principal;
using Microsoft.Win32.SafeHandles;

namespace LogBrew
{
    [SupportedOSPlatform("windows")]
    internal static partial class DurableWindowsAccessControl
    {
        private const uint FileObject = 1;
        private const uint OwnerSecurityInformation = 1;
        private const uint DaclSecurityInformation = 4;
        private const int ErrorAlreadyExists = 183;
        private const int FullControlAccessMask = 0x001F01FF;
        private const int MaximumAclBytes = 65_535;

        internal static bool CreateDirectory(string path)
        {
            var owner = CurrentOwner();
            var dacl = CreateOwnerOnlyDacl(owner);
            var descriptor = new RawSecurityDescriptor(
                ControlFlags.DiscretionaryAclPresent
                    | ControlFlags.DiscretionaryAclProtected
                    | ControlFlags.SelfRelative,
                owner,
                owner,
                systemAcl: null,
                dacl);
            var descriptorBytes = new byte[descriptor.BinaryLength];
            descriptor.GetBinaryForm(descriptorBytes, 0);
            unsafe
            {
                fixed (byte* descriptorPointer = descriptorBytes)
                {
                    var attributes = new WindowsSecurityAttributes
                    {
                        Length = Marshal.SizeOf<WindowsSecurityAttributes>(),
                        SecurityDescriptor = (IntPtr)descriptorPointer,
                    };
                    if (CreateDirectoryWindows(path, ref attributes))
                    {
                        return true;
                    }
                }
            }

            if (Marshal.GetLastPInvokeError() == ErrorAlreadyExists)
            {
                return false;
            }

            throw StorageUnavailable();
        }

        internal static void RequireOwnerOnly(SafeFileHandle handle, bool requireProtected)
        {
            var result = GetSecurityInfo(
                handle,
                FileObject,
                OwnerSecurityInformation | DaclSecurityInformation,
                out var ownerPointer,
                out _,
                out var daclPointer,
                out _,
                out var descriptorPointer);
            if (result != 0 || descriptorPointer == IntPtr.Zero)
            {
                throw OwnerOnlyFailure("descriptor");
            }

            try
            {
                if (ownerPointer == IntPtr.Zero || daclPointer == IntPtr.Zero)
                {
                    throw OwnerOnlyFailure("security-pointer");
                }

                if (!GetSecurityDescriptorControl(descriptorPointer, out var control, out _))
                {
                    throw OwnerOnlyFailure("control");
                }

                if (requireProtected
                    && (((ControlFlags)control & ControlFlags.DiscretionaryAclProtected) == 0))
                {
                    throw OwnerOnlyFailure("protection");
                }

                var owner = CurrentOwner();
                if (!owner.Equals(new SecurityIdentifier(ownerPointer)))
                {
                    throw OwnerOnlyFailure("owner");
                }

                var aclLength = unchecked((ushort)Marshal.ReadInt16(daclPointer, 2));
                if (aclLength == 0 || aclLength > MaximumAclBytes)
                {
                    throw OwnerOnlyFailure("acl-length");
                }

                var aclBytes = new byte[aclLength];
                Marshal.Copy(daclPointer, aclBytes, 0, aclBytes.Length);
                var dacl = new RawAcl(aclBytes, 0);
                if (dacl.Count != 1)
                {
                    throw OwnerOnlyFailure("ace-count");
                }

                if (dacl[0] is not CommonAce ace)
                {
                    throw OwnerOnlyFailure("ace-kind");
                }

                if (ace.AceQualifier != AceQualifier.AccessAllowed)
                {
                    throw OwnerOnlyFailure("ace-qualifier");
                }

                if (ace.AccessMask != FullControlAccessMask)
                {
                    throw OwnerOnlyFailure("access-mask");
                }

                if (!owner.Equals(ace.SecurityIdentifier))
                {
                    throw OwnerOnlyFailure("principal");
                }

                if (requireProtected && !HasDirectoryInheritance(ace.AceFlags))
                {
                    throw OwnerOnlyFailure("inheritance");
                }
            }
            finally
            {
                _ = LocalFree(descriptorPointer);
            }
        }

        private static SecurityIdentifier CurrentOwner()
        {
            using var identity = WindowsIdentity.GetCurrent();
            return identity.User ?? throw StorageUnavailable();
        }

        private static RawAcl CreateOwnerOnlyDacl(SecurityIdentifier owner)
        {
            var dacl = new RawAcl(revision: 2, capacity: 1);
            dacl.InsertAce(
                0,
                new CommonAce(
                    AceFlags.ContainerInherit | AceFlags.ObjectInherit,
                    AceQualifier.AccessAllowed,
                    FullControlAccessMask,
                    owner,
                    isCallback: false,
                    opaque: null));
            return dacl;
        }

        private static bool HasDirectoryInheritance(AceFlags flags)
        {
            const AceFlags required = AceFlags.ContainerInherit | AceFlags.ObjectInherit;
            const AceFlags prohibited = AceFlags.InheritOnly | AceFlags.NoPropagateInherit;
            return (flags & required) == required && (flags & prohibited) == 0;
        }

        private static SdkException StorageUnavailable()
        {
            return new SdkException("storage_error", "durable delivery storage is unavailable");
        }

        private static SdkException OwnerOnlyFailure(string reason)
        {
#if LOGBREW_TEST_HOOKS
            DurableStoreTestHooks.Reach("store-owner-security-failed-" + reason);
#endif
            return StorageUnavailable();
        }

        [LibraryImport("kernel32.dll", EntryPoint = "CreateDirectoryW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool CreateDirectoryWindows(string path, ref WindowsSecurityAttributes securityAttributes);

        [LibraryImport("advapi32.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static partial uint GetSecurityInfo(
            SafeFileHandle handle,
            uint objectType,
            uint securityInformation,
            out IntPtr owner,
            out IntPtr group,
            out IntPtr dacl,
            out IntPtr sacl,
            out IntPtr securityDescriptor);

        [LibraryImport("advapi32.dll", SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static partial bool GetSecurityDescriptorControl(
            IntPtr securityDescriptor,
            out ushort control,
            out uint revision);

        [LibraryImport("kernel32.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        private static partial IntPtr LocalFree(IntPtr memory);

        [StructLayout(LayoutKind.Sequential)]
        private struct WindowsSecurityAttributes
        {
            internal int Length;
            internal IntPtr SecurityDescriptor;
            internal int InheritHandle;
        }
    }
}
#endif
