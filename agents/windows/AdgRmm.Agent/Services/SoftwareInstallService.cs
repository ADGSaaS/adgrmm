using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Services;

/// <summary>Runs software_install tasks, one at a time. The logic lives in <see cref="SoftwareInstall"/>; this supplies the real machine.</summary>
public sealed class SoftwareInstallService
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private readonly InventoryService _inventory;
    private readonly ILogger<SoftwareInstallService> _log;

    public SoftwareInstallService(InventoryService inventory, ILogger<SoftwareInstallService> log)
    {
        _inventory = inventory; _log = log;
    }

    public async Task<SoftwareInstallResult> RunAsync(SoftwareInstallRequest request, CancellationToken ct)
    {
        await Gate.WaitAsync(ct); // a second install waits for the first
        try
        {
            var result = await SoftwareInstall.RunAsync(request, new WindowsInstallHost(), ct);
            _log.LogInformation("software_install {Action} {Name}: ok={Ok} exit={Exit}", request.Action, request.Name, result.Ok, result.ExitCode);
            if (result.Ok)
            {
                try { _inventory.RequestRefresh(); } catch { /* the next scheduled inventory will pick it up */ }
            }
            return result;
        }
        finally
        {
            Gate.Release();
        }
    }

    /// <summary>Looks for outdated programs (winget, Chocolatey). Nothing is changed. Waits for a running install, so two winget runs never overlap.</summary>
    public async Task<UpdatesScanResult> ScanAsync(UpdatesScanRequest request, CancellationToken ct)
    {
        await Gate.WaitAsync(ct);
        try
        {
            var result = await SoftwareUpdates.ScanAsync(request, new WindowsInstallHost(), ct);
            _log.LogInformation("software_updates_scan: ok={Ok} apps={Count} winget={W} choco={C}", result.Ok, result.Apps.Count, result.Winget.State, result.Chocolatey.State);
            return result;
        }
        finally
        {
            Gate.Release();
        }
    }

    private sealed class WindowsInstallHost : ISoftwareUpgradeHost
    {
        public string? ResolveWingetPath()
        {
            try
            {
                var pf = Environment.GetEnvironmentVariable("ProgramFiles") ?? @"C:\Program Files";
                var root = Path.Combine(pf, "WindowsApps");
                if (Directory.Exists(root))
                {
                    var names = Directory.GetDirectories(root, "Microsoft.DesktopAppInstaller_*__8wekyb3d8bbwe").Select(d => Path.GetFileName(d)!).ToList();
                    var pick = SoftwareUpdates.PickWingetFolder(names);
                    if (pick is not null)
                    {
                        var exe = Path.Combine(root, pick, "winget.exe");
                        if (File.Exists(exe)) return exe;
                    }
                }
            }
            catch { /* not readable: fall through to PATH */ }
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
            {
                try
                {
                    var exe = Path.Combine(dir.Trim(), "winget.exe");
                    if (File.Exists(exe)) return exe;
                }
                catch { /* a bad PATH entry */ }
            }
            return null;
        }

        public Task<IReadOnlyList<InstalledProgram>> ListInstalledAsync(CancellationToken ct) => Task.Run<IReadOnlyList<InstalledProgram>>(
            () => SystemInfoCollector.CollectMachineSoftware().Select(i => new InstalledProgram(i.Name, i.Version)).ToList(), ct);

        private static readonly HttpClient Http = new(new SocketsHttpHandler { AllowAutoRedirect = true, MaxAutomaticRedirections = 5 })
        {
            Timeout = SoftwareInstall.Limit
        };

        public string ChocolateyExe => Path.Combine(
            Environment.GetEnvironmentVariable("ProgramData") ?? @"C:\ProgramData", "chocolatey", "bin", "choco.exe");

        public bool FileExists(string path) => File.Exists(path);

        public Task DelayAsync(TimeSpan delay, CancellationToken ct) => Task.Delay(delay, ct);

        // The same sources as the inventory: machine lists plus real users hives. SYSTEM and service profiles are not users.
        // For one user: only that user's own hive. Otherwise machine programs plus every real user.
        public Task<IReadOnlyList<string>> ListInstalledNamesAsync(string? user, CancellationToken ct) => Task.Run<IReadOnlyList<string>>(() =>
        {
            if (user is not null)
                return UserSoftwareReader.ReadAllUsers(null, a => SoftwareInventoryCore.SameAccount(a, user, Environment.MachineName)).Select(i => i.Name).ToList();
            return SystemInfoCollector.CollectMachineSoftware().Concat(UserSoftwareReader.ReadAllUsers()).Select(i => i.Name).ToList();
        }, ct);

        public Task<bool> IsUserSignedInAsync(string user, CancellationToken ct) => Task.Run(() => UserSessions.Find(user) is not null, ct);

        public Task<ProcessOutcome> RunAsUserAsync(string user, string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct) =>
            UserSessions.RunAsync(user, file, args, timeout, SoftwareInstall.MaxOutputBytes, ct);

        public string CreateTempDir(string? readableBy)
        {
            // SYSTEM's temp folder is not readable by users, so an installer that runs as a user is downloaded under ProgramData instead.
            // Either way the folder is created with a SYSTEM and Administrators only ACL, so nobody else can swap the installer
            // between its download, its hash check and its run as SYSTEM.
            var dir = PrivateFolders.CreateRandomPrivateDir("adg-sw-", readableBy is null ? null : Path.Combine(PrivateFolders.DataDir, "software-tmp"));
            if (readableBy is not null)
            {
                var info = new DirectoryInfo(dir);
                var acl = info.GetAccessControl();
                acl.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(new System.Security.Principal.NTAccount(readableBy),
                    System.Security.AccessControl.FileSystemRights.ReadAndExecute,
                    System.Security.AccessControl.InheritanceFlags.ContainerInherit | System.Security.AccessControl.InheritanceFlags.ObjectInherit,
                    System.Security.AccessControl.PropagationFlags.None, System.Security.AccessControl.AccessControlType.Allow));
                info.SetAccessControl(acl);
            }
            return dir;
        }

        public void DeleteDir(string path) => Directory.Delete(path, recursive: true);

        public async Task DownloadAsync(Uri url, string destinationPath, CancellationToken ct)
        {
            using var resp = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
            resp.EnsureSuccessStatusCode();
            if (resp.RequestMessage?.RequestUri?.Scheme != Uri.UriSchemeHttps)
                throw new InvalidOperationException("The download was redirected away from https.");
            await using var src = await resp.Content.ReadAsStreamAsync(ct);
            await using var dst = File.Create(destinationPath);
            await src.CopyToAsync(dst, ct);
        }

        public async Task<string> Sha256Async(string path, CancellationToken ct)
        {
            await using var fs = File.OpenRead(path);
            return Convert.ToHexString(await SHA256.HashDataAsync(fs, ct)).ToLowerInvariant();
        }

        public async Task<ProcessOutcome> RunAsync(string file, IReadOnlyList<string> args, TimeSpan timeout, CancellationToken ct)
        {
            var psi = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = true,
            };
            // winget writes UTF-8 even when redirected; read it that way so translated names and the table columns stay intact.
            if (Path.GetFileName(file).Equals("winget.exe", StringComparison.OrdinalIgnoreCase))
            {
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
            }
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var proc = new Process { StartInfo = psi };
            var so = new Capped(SoftwareInstall.MaxOutputBytes);
            var se = new Capped(SoftwareInstall.MaxOutputBytes);
            proc.OutputDataReceived += (_, e) => so.Add(e.Data);
            proc.ErrorDataReceived += (_, e) => se.Add(e.Data);
            proc.Start();
            try { proc.StandardInput.Close(); } catch { /* ignore */ }
            proc.BeginOutputReadLine();
            proc.BeginErrorReadLine();

            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(timeout);
            var timedOut = false;
            try
            {
                await proc.WaitForExitAsync(cts.Token);
                proc.WaitForExit(); // flush the output readers
            }
            catch (OperationCanceledException)
            {
                timedOut = !ct.IsCancellationRequested;
                try { proc.Kill(entireProcessTree: true); } catch { /* already gone */ }
                try { await proc.WaitForExitAsync(CancellationToken.None).WaitAsync(TimeSpan.FromSeconds(10)); } catch { /* ignore */ }
                if (!timedOut) throw;
            }
            return new ProcessOutcome(timedOut ? null : proc.ExitCode, so.ToString(), se.ToString(), timedOut);
        }
    }

    /// <summary>Keeps the first N bytes of a stream of lines and drops the rest, so a chatty installer cannot use up memory.</summary>
    private sealed class Capped
    {
        private readonly StringBuilder _sb = new();
        private readonly int _max;
        private bool _full;
        public Capped(int max) { _max = max; }
        public void Add(string? line)
        {
            if (line is null) return;
            lock (_sb)
            {
                if (_full) return;
                if (_sb.Length + line.Length + 1 > _max) { _sb.Append("\n[output truncated]"); _full = true; return; }
                _sb.AppendLine(line);
            }
        }
        public override string ToString() { lock (_sb) return _sb.ToString(); }
    }
}
