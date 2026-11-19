using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;

namespace QAgent
{
    internal static class TaskbarCompletionBadge
    {
        [ComImport, Guid("56FDF344-FD6D-11D0-958A-006097C9A090")]
        private class TaskbarList { }

        // Keep inherited methods in COM vtable order.
        [ComImport, Guid("EA1AFB91-9E28-4B86-90E9-9E9F8A5EEFAF"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface ITaskbarList3
        {
            void HrInit();
            void AddTab(IntPtr window);
            void DeleteTab(IntPtr window);
            void ActivateTab(IntPtr window);
            void SetActiveAlt(IntPtr window);
            void MarkFullscreenWindow(IntPtr window, [MarshalAs(UnmanagedType.Bool)] bool fullscreen);
            void SetProgressValue(IntPtr window, ulong completed, ulong total);
            void SetProgressState(IntPtr window, uint flags);
            void RegisterTab(IntPtr tab, IntPtr window);
            void UnregisterTab(IntPtr tab);
            void SetTabOrder(IntPtr tab, IntPtr before);
            void SetTabActive(IntPtr tab, IntPtr window, uint reserved);
            void ThumbBarAddButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarUpdateButtons(IntPtr window, uint count, IntPtr buttons);
            void ThumbBarSetImageList(IntPtr window, IntPtr imageList);
            void SetOverlayIcon(IntPtr window, IntPtr icon, [MarshalAs(UnmanagedType.LPWStr)] string description);
        }

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int RegisterWindowMessage(string name);

        [DllImport("user32.dll")]
        private static extern bool DestroyIcon(IntPtr icon);

        internal static readonly int ButtonCreatedMessage = RegisterWindowMessage("TaskbarButtonCreated");

        internal static void Apply(IntPtr window, int count)
        {
            ITaskbarList3 taskbar = (ITaskbarList3)new TaskbarList();
            IntPtr icon = IntPtr.Zero;
            try
            {
                taskbar.HrInit();
                if (count > 0)
                {
                    using (Bitmap image = new Bitmap(16, 16))
                    using (Graphics graphics = Graphics.FromImage(image))
                    using (SolidBrush background = new SolidBrush(Color.FromArgb(177, 30, 57)))
                    using (Font font = new Font("Segoe UI", count < 10 ? 12 : 8, FontStyle.Bold, GraphicsUnit.Pixel))
                    using (StringFormat format = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                    {
                        graphics.SmoothingMode = SmoothingMode.AntiAlias;
                        graphics.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                        graphics.FillEllipse(background, 0, 0, 16, 16);
                        graphics.DrawString(count.ToString(), font, Brushes.White, new RectangleF(0, 0, 16, 16), format);
                        icon = image.GetHicon();
                    }
                }
                taskbar.SetOverlayIcon(window, icon, count == 0 ? null : count + " 个已完成会话未查看");
            }
            finally
            {
                if (icon != IntPtr.Zero) DestroyIcon(icon);
                Marshal.ReleaseComObject(taskbar);
            }
        }
    }
}
