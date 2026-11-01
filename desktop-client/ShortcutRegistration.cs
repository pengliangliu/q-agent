using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

namespace QAgent
{
    internal static class ShortcutRegistration
    {
        [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
        private class ShellLink { }

        [StructLayout(LayoutKind.Sequential)]
        private struct PropertyKey
        {
            internal Guid FormatId;
            internal uint PropertyId;
        }
        [StructLayout(LayoutKind.Explicit, Size = 24)]
        private struct PropVariant
        {
            [FieldOffset(0)] internal ushort Type;
            [FieldOffset(8)] internal IntPtr Value;
        }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
            [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
            [PreserveSig] int Commit();
        }
        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        internal static void Register(string file, string appId)
        {
            string full = Path.GetFullPath(file);
            string programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs) + Path.DirectorySeparatorChar;
            string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory) + Path.DirectorySeparatorChar;
            if (!File.Exists(full) || !full.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) ||
                !Path.GetFileName(full).StartsWith("Q-agent", StringComparison.Ordinal) ||
                !(full.StartsWith(programs, StringComparison.OrdinalIgnoreCase) || full.StartsWith(desktop, StringComparison.OrdinalIgnoreCase)))
                throw new ArgumentException("Expected an existing Q-agent shortcut in Desktop or Start Menu.");
            object link = new ShellLink();
            try
            {
                IPersistFile persisted = (IPersistFile)link;
                persisted.Load(full, 2);
                IPropertyStore properties = (IPropertyStore)link;
                PropertyKey key = new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
                PropVariant value = new PropVariant { Type = 31, Value = Marshal.StringToCoTaskMemUni(appId) };
                try { Marshal.ThrowExceptionForHR(properties.SetValue(ref key, ref value)); Marshal.ThrowExceptionForHR(properties.Commit()); }
                finally { PropVariantClear(ref value); }
                persisted.Save(full, true);
                PropVariant actual;
                Marshal.ThrowExceptionForHR(properties.GetValue(ref key, out actual));
                try { if (actual.Type != 31 || Marshal.PtrToStringUni(actual.Value) != appId) throw new InvalidOperationException("Shortcut identity verification failed."); }
                finally { PropVariantClear(ref actual); }
            }
            finally { Marshal.FinalReleaseComObject(link); }
        }
    }
}
