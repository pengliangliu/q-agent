using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Cache;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace QAgent
{
    internal sealed class BackendStartup : IDisposable
    {
        private const string StartCommand = "systemctl --user start agent-deck-web-local.service agent-deck-desktop.service && exec cat >/dev/null";
        private readonly string configurationFile;
        private readonly string wslExecutable;
        private readonly Func<CancellationToken, Task<bool>> healthProbe;
        private readonly SemaphoreSlim startupGate = new SemaphoreSlim(1, 1);
        private readonly CancellationTokenSource lifetime = new CancellationTokenSource();
        private readonly object processLock = new object();
        private Process keeper;
        private string keeperDistro;
        private string keeperUser;
        private volatile bool disposed;

        internal BackendStartup()
            : this(Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "wsl.json")),
                   Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "wsl.exe"), null)
        {
        }

        // The private fixture supplies a harmless executable and health probe.
        internal BackendStartup(string configurationFile, string wslExecutable,
                                Func<CancellationToken, Task<bool>> healthProbe)
        {
            this.configurationFile = configurationFile;
            this.wslExecutable = wslExecutable;
            this.healthProbe = healthProbe ?? new Func<CancellationToken, Task<bool>>(ProbeHttpAsync);
        }

        internal async Task EnsureAsync(Action<string> progress, CancellationToken token)
        {
            bool entered = false;
            Process created = null;
            using (CancellationTokenSource attempt = CancellationTokenSource.CreateLinkedTokenSource(token, lifetime.Token))
            {
                attempt.CancelAfter(TimeSpan.FromSeconds(60));
                try
                {
                    await startupGate.WaitAsync(attempt.Token).ConfigureAwait(false);
                    entered = true;
                    attempt.Token.ThrowIfCancellationRequested();
                    string[] configuration = ReadConfiguration();
                    Process current;
                    lock (processLock)
                    {
                        ThrowIfDisposed();
                        current = keeper;
                    }
                    if (IsAlive(current) && keeperDistro == configuration[0] && keeperUser == configuration[1] &&
                        await CheckHealthAsync(attempt.Token).ConfigureAwait(false) && IsAlive(current))
                    {
                        Report(progress, "本地后台已连接。");
                        return;
                    }

                    Report(progress, current == null ? "正在启动 WSL 后台…" : "正在恢复本地后台…");
                    attempt.Token.ThrowIfCancellationRequested();
                    lock (processLock)
                    {
                        ThrowIfDisposed();
                        // A live shell alone does not mean the services are healthy.
                        // Replace only our keeper, immediately, without stopping any service.
                        CloseKeeperLocked();
                        created = StartKeeper(configuration[0], configuration[1]);
                        keeper = created;
                        keeperDistro = configuration[0];
                        keeperUser = configuration[1];
                    }
                    Report(progress, "正在等待本地服务就绪…");
                    while (true)
                    {
                        attempt.Token.ThrowIfCancellationRequested();
                        if (!IsAlive(created))
                        {
                            attempt.Token.ThrowIfCancellationRequested();
                            throw new InvalidOperationException("WSL 后台未能保持运行，请检查发行版、Linux 用户及 systemd 用户服务。");
                        }
                        if (await CheckHealthAsync(attempt.Token).ConfigureAwait(false) && IsAlive(created))
                        {
                            Report(progress, "本地后台已就绪。");
                            return;
                        }
                        await Task.Delay(500, attempt.Token).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException)
                {
                    ReleaseAttempt(created);
                    if (token.IsCancellationRequested || lifetime.IsCancellationRequested || disposed) throw;
                    throw new TimeoutException("启动本地后台超时，请检查 WSL 环境后重试。");
                }
                catch
                {
                    ReleaseAttempt(created);
                    throw;
                }
                finally
                {
                    if (entered) startupGate.Release();
                }
            }
        }

        private string[] ReadConfiguration()
        {
            if (!File.Exists(configurationFile))
                throw new InvalidOperationException("未找到客户端的 WSL 配置，请先运行 Q-agent 环境向导。");
            try
            {
                if (new FileInfo(configurationFile).Length > 16384) throw new FormatException();
                JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 16384, RecursionLimit = 8 };
                Dictionary<string, object> data = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configurationFile));
                object distroValue, userValue;
                if (data == null || !data.TryGetValue("distro", out distroValue) || !data.TryGetValue("user", out userValue))
                    throw new FormatException();
                string distro = distroValue as string;
                string user = userValue as string;
                if (!ValidName(distro, 128) || !ValidName(user, 64) || user == "root" ||
                    !Regex.IsMatch(user, @"^[A-Za-z0-9_.-]{1,64}$", RegexOptions.CultureInvariant))
                    throw new FormatException();
                return new string[] { distro, user };
            }
            catch
            {
                throw new InvalidOperationException("WSL 配置无效，请重新运行 Q-agent 环境向导并选择普通 Linux 用户。");
            }
        }

        private static bool ValidName(string value, int maximum)
        {
            if (String.IsNullOrWhiteSpace(value) || value.Length > maximum || value[0] == '-' || value.IndexOf('"') >= 0)
                return false;
            foreach (char character in value) if (Char.IsControl(character)) return false;
            return true;
        }

        private Process StartKeeper(string distro, string user)
        {
            if (!File.Exists(wslExecutable))
                throw new InvalidOperationException("当前 Windows 未找到 WSL，请先运行 Q-agent 环境向导。");
            Process process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = wslExecutable,
                Arguments = String.Join(" ", new string[] { QuoteArgument("-d"), QuoteArgument(distro), QuoteArgument("-u"),
                    QuoteArgument(user), QuoteArgument("--exec"), QuoteArgument("sh"), QuoteArgument("-c"), QuoteArgument(StartCommand) }),
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };
            try
            {
                // Drain both pipes, without retaining or logging their contents.
                process.OutputDataReceived += delegate { };
                process.ErrorDataReceived += delegate { };
                if (!process.Start()) throw new InvalidOperationException();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                return process;
            }
            catch
            {
                CloseProcess(process);
                throw new InvalidOperationException("无法启动 WSL 后台，请检查 WSL 安装、发行版及 Linux 用户配置。");
            }
        }

        private static string QuoteArgument(string value)
        {
            // WSL parses unquoted flags itself; quote only arguments that need it.
            if (value.Length > 0 && !Regex.IsMatch(value, "[\\s\"]")) return value;
            StringBuilder result = new StringBuilder("\"");
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { backslashes++; continue; }
                result.Append('\\', character == '"' ? backslashes * 2 + 1 : backslashes);
                result.Append(character);
                backslashes = 0;
            }
            result.Append('\\', backslashes * 2);
            return result.Append('"').ToString();
        }

        private bool IsAlive(Process process)
        {
            lock (processLock)
            {
                if (disposed || process == null || process != keeper) return false;
                try { return !process.HasExited; }
                catch (InvalidOperationException) { return false; }
            }
        }

        private async Task<bool> CheckHealthAsync(CancellationToken token)
        {
            try { return await healthProbe(token).ConfigureAwait(false); }
            catch (OperationCanceledException) { throw; }
            catch { token.ThrowIfCancellationRequested(); return false; }
        }

        private static HttpWebRequest CreateHealthRequest()
        {
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:8421/api/menu");
            request.Method = "GET";
            request.Proxy = null;
            request.AllowAutoRedirect = false;
            request.KeepAlive = false;
            request.Timeout = 2000;
            request.ReadWriteTimeout = 2000;
            request.CachePolicy = new RequestCachePolicy(RequestCacheLevel.NoCacheNoStore);
            request.Headers[HttpRequestHeader.CacheControl] = "no-cache, no-store";
            request.Headers[HttpRequestHeader.Pragma] = "no-cache";
            return request;
        }

        private static async Task<bool> ProbeHttpAsync(CancellationToken token)
        {
            HttpWebRequest request = CreateHealthRequest();
            using (CancellationTokenSource probe = CancellationTokenSource.CreateLinkedTokenSource(token))
            {
                probe.CancelAfter(2000);
                using (probe.Token.Register(delegate { request.Abort(); }))
                {
                    try
                    {
                        using (HttpWebResponse response = (HttpWebResponse)await request.GetResponseAsync().ConfigureAwait(false))
                            return response.StatusCode == HttpStatusCode.OK;
                    }
                    catch (WebException)
                    {
                        token.ThrowIfCancellationRequested();
                        return false;
                    }
                }
            }
        }

        private static void Report(Action<string> progress, string message)
        {
            if (progress == null) return;
            try { progress(message); }
            catch (ObjectDisposedException) { }
            catch (InvalidOperationException) { }
        }

        private void ThrowIfDisposed()
        {
            if (disposed) throw new OperationCanceledException(lifetime.Token);
        }

        private void ReleaseAttempt(Process process)
        {
            if (process == null) return;
            lock (processLock) if (keeper == process) CloseKeeperLocked();
        }

        private static void CloseProcess(Process process)
        {
            try { process.StandardInput.Close(); }
            catch (InvalidOperationException) { }
            catch (IOException) { }
            try { process.Dispose(); }
            catch (InvalidOperationException) { }
        }

        private void CloseKeeperLocked()
        {
            Process process = keeper;
            keeper = null;
            keeperDistro = null;
            keeperUser = null;
            if (process != null) CloseProcess(process);
        }

        public void Dispose()
        {
            lock (processLock)
            {
                if (disposed) return;
                disposed = true;
            }
            lifetime.Cancel();
            lock (processLock) CloseKeeperLocked();
            // Keep gate/token objects valid while cancelled EnsureAsync calls unwind.
            // Closing stdin releases only this cat process; no WSL shutdown is issued.
        }
    }
}
