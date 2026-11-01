using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Threading;
using System.Windows.Forms;

namespace QAgent
{
    internal static class Program
    {
        internal const string AppId = "QAgent.Desktop";
        internal static readonly string DataFolder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QAgent");
        internal static readonly string UserDataFolder = Path.Combine(DataFolder, "WebView2");
        internal static MainForm MainWindow;
        internal static NativeNotifications Notifications;

        [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);

        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length == 2 && args[0] == "--register-shortcut")
            {
                try { ShortcutRegistration.Register(args[1], AppId); return 0; }
                catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
            }
            if (args.Length != 0) return 2;
            Directory.CreateDirectory(DataFolder);
            string user = WindowsIdentity.GetCurrent().User.Value;
            using (EventWaitHandle activation = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\QAgent.Activate." + user))
            {
                bool created;
                using (Mutex instance = new Mutex(true, "Local\\QAgent.Desktop." + user, out created))
                {
                    if (!created) { activation.Set(); return 0; }
                    RegisteredWaitHandle wait = null;
                    try
                    {
                        Marshal.ThrowExceptionForHR(SetCurrentProcessExplicitAppUserModelID(AppId));
                        Application.EnableVisualStyles();
                        Application.SetCompatibleTextRenderingDefault(false);
                        MainWindow = new MainForm(null, new Uri(MainForm.AppUrl), true);
                        Notifications = new NativeNotifications(delegate(string sessionId) { MainWindow.FocusSession(sessionId); });
                        wait = ThreadPool.RegisterWaitForSingleObject(activation, delegate(object state, bool timedOut)
                        {
                            MainForm window = MainWindow;
                            if (window != null && window.IsHandleCreated && !window.IsDisposed)
                                window.BeginInvoke(new Action(window.FocusWindow));
                        }, null, Timeout.Infinite, false);
                        Application.Run(MainWindow);
                        return 0;
                    }
                    catch (Exception error)
                    {
                        MessageBox.Show("Q-agent 无法启动。\n" + error.Message, "Q-agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return 1;
                    }
                    finally
                    {
                        if (wait != null) wait.Unregister(null);
                        if (Notifications != null) Notifications.Dispose();
                        instance.ReleaseMutex();
                    }
                }
            }
        }
    }
}
