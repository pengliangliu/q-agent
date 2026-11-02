using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace QAgent
{
    internal sealed class MainForm : Form
    {
        internal const string AppUrl = "http://127.0.0.1:8421/?ui=chat-v2";
        private readonly WebView2 web;
        private readonly Panel statusPanel;
        private readonly Label statusLabel;
        private readonly Button retry;
        private readonly Uri initialUri;
        private readonly bool main;
        private CoreWebView2Environment environment;
        private Task initialization;
        private Task reconnection;
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private bool closing;
        private bool documentReady;
        private bool listenerReady;
        private CoreWebView2MemoryUsageTargetLevel? memoryTarget;
        private string pendingSession;
        private string runtimeVersion = "";
        private FormWindowState previousState = FormWindowState.Normal;
        private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 8192 };

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr window);

        internal MainForm(CoreWebView2Environment sharedEnvironment, Uri uri, bool isMain)
        {
            environment = sharedEnvironment; initialUri = uri; main = isMain;
            Text = "Q-agent";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            BackColor = Color.FromArgb(19, 23, 34);
            StartPosition = FormStartPosition.CenterScreen;
            Rectangle screen = Screen.PrimaryScreen.WorkingArea;
            Size = new Size(Math.Min(1440, screen.Width - 40), Math.Min(940, screen.Height - 40));
            MinimumSize = new Size(760, 520);
            AutoScaleMode = AutoScaleMode.Dpi;
            web = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = BackColor };
            Controls.Add(web);
            statusPanel = new Panel { Dock = DockStyle.Fill, BackColor = BackColor };
            statusLabel = new Label { Dock = DockStyle.Fill, ForeColor = Color.Gainsboro,
                Text = "正在打开 Q-agent…", TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Microsoft YaHei UI", 11F) };
            retry = new Button { Text = "重试", Dock = DockStyle.Bottom, Height = 42, Visible = false };
            retry.Click += async delegate
            {
                await ReconnectAsync();
            };
            statusPanel.Controls.Add(statusLabel); statusPanel.Controls.Add(retry);
            Controls.Add(statusPanel); statusPanel.BringToFront();
            Shown += async delegate { await InitializeAsync(); };
        }

        internal Task InitializeAsync()
        {
            if (initialization == null) initialization = InitializeCoreAsync();
            return initialization;
        }

        private async Task InitializeCoreAsync()
        {
            try
            {
                if (main) await Program.Backend.EnsureAsync(ReportBackendProgress, lifetime.Token);
                if (closing) return;
                statusLabel.Text = "后台已就绪，正在打开聊天界面…";
                runtimeVersion = CoreWebView2Environment.GetAvailableBrowserVersionString();
                if (environment == null) environment = await CoreWebView2Environment.CreateAsync(null, Program.UserDataFolder);
                if (closing) return;
                await web.EnsureCoreWebView2Async(environment);
                if (closing) return;
                CoreWebView2 core = web.CoreWebView2;
                core.Settings.IsBuiltInErrorPageEnabled = false;
                core.Settings.IsPasswordAutosaveEnabled = false;
                core.Settings.IsGeneralAutofillEnabled = false;
                core.NavigationStarting += OnNavigationStarting;
                core.NavigationCompleted += OnNavigationCompleted;
                core.NewWindowRequested += OnNewWindowRequested;
                core.WebMessageReceived += OnWebMessageReceived;
                core.PermissionRequested += delegate(object sender, CoreWebView2PermissionRequestedEventArgs args)
                {
                    if (args.PermissionKind == CoreWebView2PermissionKind.Notifications)
                        args.State = CoreWebView2PermissionState.Deny;
                };
                core.ProcessFailed += delegate(object sender, CoreWebView2ProcessFailedEventArgs args)
                {
                    if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited ||
                        args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                        args.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                        ShowError("界面进程暂时不可用，请重试或重新打开 Q-agent。", args.ProcessFailedKind.ToString());
                };
                string capability = Program.Notifications != null && Program.Notifications.Available ? "true" : "false";
                string notificationStatus = json.Serialize(Program.Notifications == null ? "Unavailable" : Program.Notifications.SettingName);
                await core.AddScriptToExecuteOnDocumentCreatedAsync(
                    "(()=>{if(location.origin==='http://127.0.0.1:8421'||location.origin==='http://localhost:8421')" +
                    "{Object.defineProperty(window,'__agentDeckDesktop',{value:Object.freeze({host:'agentdeck-winforms',protocol:1,notifications:" + capability + ",notificationStatus:" + notificationStatus + "}),writable:false,configurable:false});}})();");
                if (closing) return;
                ApplyMemoryTarget();
                if (initialUri != null) core.Navigate(initialUri.AbsoluteUri);
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { if (!closing) ShowError("启动未完成：" + error.Message + "\n点击重试可重新启动并连接后台。", error.GetType().Name); }
        }

        private void ReportBackendProgress(string message)
        {
            if (closing || IsDisposed || !IsHandleCreated) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new Action<string>(ReportBackendProgress), message); }
                catch (InvalidOperationException) { }
                return;
            }
            statusLabel.Text = message;
        }

        private Task ReconnectAsync()
        {
            if (reconnection == null || reconnection.IsCompleted) reconnection = ReconnectCoreAsync();
            return reconnection;
        }

        private async Task ReconnectCoreAsync()
        {
            if (closing) return;
            bool reload = !documentReady;
            if (reload) { statusPanel.Visible = true; statusPanel.BringToFront(); }
            retry.Visible = false;
            try
            {
                if (web.CoreWebView2 == null)
                {
                    if (initialization == null || initialization.IsCompleted) initialization = null;
                    await InitializeAsync();
                }
                else
                {
                    await Program.Backend.EnsureAsync(ReportBackendProgress, lifetime.Token);
                    if (!closing)
                    {
                        if (reload) web.CoreWebView2.Navigate((initialUri ?? new Uri(AppUrl)).AbsoluteUri);
                        else { statusPanel.Visible = false; web.Visible = true; }
                    }
                }
            }
            catch (OperationCanceledException) { }
            catch (Exception error) { if (!closing) ShowError("后台连接未恢复：" + error.Message, error.GetType().Name); }
        }

        internal static bool InternalUrl(string text)
        {
            Uri uri;
            return Uri.TryCreate(text, UriKind.Absolute, out uri) && uri.Scheme == "http" && uri.Port == 8421 &&
                String.IsNullOrEmpty(uri.UserInfo) && (uri.Host == "127.0.0.1" || uri.Host == "localhost");
        }

        private static void OpenExternal(string value)
        {
            Uri uri;
            if (Uri.TryCreate(value, UriKind.Absolute, out uri) && (uri.Scheme == "https" || uri.Scheme == "http") && String.IsNullOrEmpty(uri.UserInfo))
                Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }

        private void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs args)
        {
            if (InternalUrl(args.Uri)) { documentReady = false; listenerReady = false; return; }
            args.Cancel = true;
            try { OpenExternal(args.Uri); } catch (Exception error) { WriteState("ready", error.Message); }
        }

        private async void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (closing) return;
            if (!args.IsSuccess || args.HttpStatusCode >= 400)
            {
                ShowError("本地界面尚未就绪。点击重试，客户端会自动启动并连接后台。", args.WebErrorStatus.ToString());
                return;
            }
            if (!InternalUrl(web.CoreWebView2.Source)) return;
            documentReady = true; statusPanel.Visible = false; web.Visible = true;
            try
            {
                string bridge = await web.CoreWebView2.ExecuteScriptAsync("Boolean(window.__agentDeckDesktop&&window.__agentDeckDesktop.host==='agentdeck-winforms'&&window.__agentDeckDesktop.protocol===1)");
                WriteState("ready", bridge == "true" ? "" : "Native bridge was not initialized.");
            }
            catch (Exception error) { WriteState("ready", error.Message); }
            FlushPendingSession();
        }

        private async void OnNewWindowRequested(object sender, CoreWebView2NewWindowRequestedEventArgs args)
        {
            args.Handled = true;
            if (!InternalUrl(args.Uri))
            {
                try { OpenExternal(args.Uri); } catch (Exception error) { WriteState("ready", error.Message); }
                return;
            }
            CoreWebView2Deferral deferral = args.GetDeferral();
            MainForm child = null;
            try
            {
                child = new MainForm(environment, null, false);
                child.Show(Program.MainWindow);
                await child.InitializeAsync();
                if (!closing && child.web.CoreWebView2 != null) args.NewWindow = child.web.CoreWebView2;
                else child.Close();
            }
            catch (Exception error) { if (child != null) child.Close(); WriteState("ready", error.Message); }
            finally { deferral.Complete(); }
        }

        private void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            if (closing || !InternalUrl(args.Source) || !InternalUrl(web.CoreWebView2.Source)) return;
            try
            {
                string raw = args.WebMessageAsJson;
                if (raw.Length > 4096) return;
                Dictionary<string, object> message = json.DeserializeObject(raw) as Dictionary<string, object>;
                if (message == null) return;
                string type = ReadString(message, "type");
                if (type == "agentdeck:ready")
                {
                    listenerReady = true; PublishNotificationStatus(); FlushPendingSession(); if (documentReady) WriteState("ready", "");
                    return;
                }
                if (type == "agentdeck:notification-status")
                {
                    PublishNotificationStatus();
                    return;
                }
                if (type != "agentdeck:notify") return;
                string sessionId = ReadString(message, "sessionId"), notificationId = ReadString(message, "notificationId");
                if (!Regex.IsMatch(sessionId, "^[A-Za-z0-9-]{8,100}$") || notificationId.Length < 1 || notificationId.Length > 256) return;
                string failure;
                string result = Program.Notifications.Show(CleanNotification(ReadString(message, "title"), 80),
                    CleanNotification(ReadString(message, "body"), 180), sessionId, notificationId, out failure);
                PublishNotificationStatus();
                PublishNotificationResult(notificationId, result, failure);
                Program.MainWindow.WriteState("ready", failure);
            }
            catch (Exception error) { Program.MainWindow.WriteState("ready", error.Message); }
        }

        private static string ReadString(Dictionary<string, object> message, string name)
        {
            object value; return message.TryGetValue(name, out value) ? value as string ?? "" : "";
        }
        private static string CleanNotification(string text, int limit)
        {
            string clean = new string(text.Where(character => !Char.IsControl(character)).ToArray()).Trim();
            return clean.Length <= limit ? clean : clean.Substring(0, limit);
        }

        private void PublishNotificationStatus()
        {
            if (!listenerReady || web.CoreWebView2 == null || !InternalUrl(web.CoreWebView2.Source)) return;
            string setting = Program.Notifications == null ? "Unavailable" : Program.Notifications.SettingName;
            web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "agentdeck:notification-status", setting = setting,
                enabled = setting == "Enabled", message = NativeNotifications.StatusMessage(setting) }));
        }
        internal void PublishNotificationResult(string notificationId, string status, string message)
        {
            if (!listenerReady || web.CoreWebView2 == null || !InternalUrl(web.CoreWebView2.Source)) return;
            string setting = Program.Notifications == null ? "Unavailable" : Program.Notifications.SettingName;
            if (String.IsNullOrEmpty(message)) message = status == "submitted" ? "提醒已交给 Windows 处理。"
                : status == "duplicate" ? "本条提醒已处理。" : NativeNotifications.StatusMessage(setting);
            web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "agentdeck:notification-result", notificationId = notificationId,
                status = status, setting = setting, message = message }));
        }

        internal async void FocusWindow()
        {
            if (closing || IsDisposed) return;
            Show(); if (WindowState == FormWindowState.Minimized) WindowState = previousState;
            BringToFront(); Activate(); SetForegroundWindow(Handle); ApplyMemoryTarget();
            if (main && initialization != null && initialization.IsCompleted) await ReconnectAsync();
        }
        internal void FocusSession(string sessionId)
        {
            if (InvokeRequired) { BeginInvoke(new Action<string>(FocusSession), sessionId); return; }
            FocusWindow();
            pendingSession = sessionId;
            FlushPendingSession();
        }
        private void FlushPendingSession()
        {
            if (pendingSession != null && documentReady && listenerReady && web.CoreWebView2 != null && InternalUrl(web.CoreWebView2.Source))
            {
                string sessionId = pendingSession;
                web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new { type = "agentdeck:notification-click", sessionId = sessionId }));
                pendingSession = null;
                WriteState("ready", "");
            }
        }

        protected override void OnResize(EventArgs args)
        {
            base.OnResize(args);
            if (WindowState != FormWindowState.Minimized) previousState = WindowState;
            ApplyMemoryTarget();
        }
        protected override void OnVisibleChanged(EventArgs args) { base.OnVisibleChanged(args); ApplyMemoryTarget(); }
        private void ApplyMemoryTarget()
        {
            if (web == null || web.CoreWebView2 == null || closing) return;
            try
            {
                CoreWebView2MemoryUsageTargetLevel target = !Visible || WindowState == FormWindowState.Minimized
                    ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal;
                if (memoryTarget == target) return;
                web.CoreWebView2.MemoryUsageTargetLevel = target;
                memoryTarget = target;
                if (documentReady) WriteState("ready", "");
            }
            catch (Exception error) { WriteState("ready", error.Message); }
        }

        private void ShowError(string message, string error)
        {
            if (closing) return;
            statusLabel.Text = message; retry.Visible = true; statusPanel.Visible = true; statusPanel.BringToFront();
            WriteState("error", error);
        }
        internal void WriteState(string status, string error)
        {
            if (!main) return;
            try
            {
                object state = new { status = status, processId = Process.GetCurrentProcess().Id,
                    browserProcessId = web.CoreWebView2 == null ? 0 : web.CoreWebView2.BrowserProcessId,
                    runtimeVersion = runtimeVersion, userDataFolder = Program.UserDataFolder,
                    origin = "http://127.0.0.1:8421", memoryTarget = memoryTarget.HasValue ? memoryTarget.Value.ToString() : "Unknown", frontendReady = listenerReady,
                    notifications = Program.Notifications == null ? false : Program.Notifications.Available,
                    notificationSetting = Program.Notifications == null ? "Unavailable" : Program.Notifications.SettingName,
                    notificationsSubmitted = Program.Notifications == null ? 0 : Program.Notifications.SubmittedCount,
                    lastNotificationSession = Program.Notifications == null ? "" : Program.Notifications.LastSession,
                    lastNotificationClick = Program.Notifications == null ? "" : Program.Notifications.LastClick,
                    updatedAt = DateTime.UtcNow.ToString("o"), error = error };
                File.WriteAllText(Path.Combine(Program.DataFolder, "client-state.json"), json.Serialize(state), Encoding.UTF8);
            }
            catch { /* Diagnostics never affect the user's session. */ }
        }

        protected override void OnFormClosing(FormClosingEventArgs args) { closing = true; lifetime.Cancel(); base.OnFormClosing(args); }
        protected override void OnFormClosed(FormClosedEventArgs args)
        {
            WriteState("closed", "");
            web.Dispose();
            base.OnFormClosed(args);
        }
    }

    internal sealed class NativeNotifications : IDisposable
    {
        private readonly Action<string> activated;
        private readonly ToastNotifier notifier;
        private readonly Dictionary<string, ToastNotification> active = new Dictionary<string, ToastNotification>();
        private readonly HashSet<string> seen = new HashSet<string>();
        private readonly Queue<string> seenOrder = new Queue<string>();
        internal bool Available { get { return notifier != null; } }
        internal int SubmittedCount { get; private set; }
        internal string SettingName
        {
            get { try { return notifier == null ? "Unavailable" : notifier.Setting.ToString(); } catch { return "Unavailable"; } }
        }
        internal string LastSession { get; private set; }
        internal string LastClick { get; private set; }

        internal NativeNotifications(Action<string> onActivated)
        {
            activated = onActivated;
            try { notifier = ToastNotificationManager.CreateToastNotifier(Program.AppId); }
            catch { notifier = null; }
        }

        internal static string StatusMessage(string setting)
        {
            switch (setting)
            {
                case "Enabled": return "Windows 系统通知可用。";
                case "DisabledForUser": return "Windows 已关闭当前用户的系统通知；站内提醒和未读标记仍然可用。";
                case "DisabledForApplication": return "Windows 已关闭 Q-agent 的系统通知；站内提醒和未读标记仍然可用。";
                case "DisabledByGroupPolicy": return "系统策略已禁用通知；站内提醒和未读标记仍然可用。";
                case "DisabledByManifest": return "Windows 尚未确认客户端的通知注册；站内提醒和未读标记仍然可用。";
                default: return "当前无法读取 Windows 通知状态；站内提醒和未读标记仍然可用。";
            }
        }

        internal string Show(string title, string body, string sessionId, string notificationId, out string failure)
        {
            failure = "";
            if (SettingName != "Enabled") return "blocked";
            if (seen.Contains(notificationId)) return "duplicate";
            string tag;
            using (SHA256 hash = SHA256.Create()) tag = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(notificationId))).Replace("-", "").Substring(0, 16);
            string imagePath = new Uri(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "agent-deck-192.png")).AbsoluteUri;
            XmlDocument xml = new XmlDocument();
            xml.LoadXml("<toast><visual><binding template=\"ToastGeneric\"><image placement=\"appLogoOverride\" src=\"" +
                SecurityElement.Escape(imagePath) + "\"/><text>" + SecurityElement.Escape(String.IsNullOrEmpty(title) ? "回复已完成" : title) +
                "</text><text>" + SecurityElement.Escape(body) + "</text></binding></visual></toast>");
            ToastNotification notification = new ToastNotification(xml) { Tag = tag, Group = "completion" };
            notification.Activated += delegate
            {
                MainForm window = Program.MainWindow;
                if (!window.IsDisposed) window.BeginInvoke(new Action(delegate
                {
                    LastClick = sessionId; active.Remove(tag); activated(sessionId);
                }));
            };
            // Retain timed-out toast handlers so Action Center clicks keep their exact session.
            notification.Dismissed += delegate(ToastNotification sender, ToastDismissedEventArgs args)
            {
                if (args.Reason != ToastDismissalReason.TimedOut && !Program.MainWindow.IsDisposed)
                    Program.MainWindow.BeginInvoke(new Action(delegate { active.Remove(tag); }));
            };
            notification.Failed += delegate(ToastNotification sender, ToastFailedEventArgs args)
            {
                string error = args.ErrorCode.Message;
                if (!Program.MainWindow.IsDisposed) Program.MainWindow.BeginInvoke(new Action(delegate
                {
                    active.Remove(tag); Program.MainWindow.PublishNotificationResult(notificationId, "failed", "Windows 未能送达提醒：" + error);
                    Program.MainWindow.WriteState("ready", "Windows notification error: " + error);
                }));
            };
            active[tag] = notification;
            try { notifier.Show(notification); }
            catch (Exception error) { active.Remove(tag); failure = "Windows 未能发送提醒：" + error.Message; return "failed"; }
            seen.Add(notificationId); seenOrder.Enqueue(notificationId);
            while (seenOrder.Count > 512) seen.Remove(seenOrder.Dequeue());
            while (active.Count > 64)
            {
                string oldest = active.Keys.First(); notifier.Hide(active[oldest]); active.Remove(oldest);
                ToastNotificationManager.History.Remove(oldest, "completion", Program.AppId);
            }
            SubmittedCount++; LastSession = sessionId;
            return "submitted";
        }

        public void Dispose()
        {
            if (notifier == null) return;
            foreach (ToastNotification notification in active.Values.ToArray()) { try { notifier.Hide(notification); } catch {} }
            active.Clear();
            try { ToastNotificationManager.History.RemoveGroup("completion", Program.AppId); } catch {}
        }
    }
}
