using System.Diagnostics;
using System.Formats.Tar;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Linux;

public sealed class LinuxUpdatePlatform : IUpdatePlatform
{
    private const string ServiceName = "adgrmm-agent";
    private const string UpdateUnit = "adgrmm-agent-update.service";
    private const string ScriptResource = "AdgRmm.Agent.Linux.apply-update.sh";
    private const string ExpectedInstallDir = "/opt/adgrmm-agent";
    private const string OpenRcUpdateService = "adgrmm-agent-update";
    public const string MuslExecutableName = "adgrmm-agent-musl";

    private readonly string _arch;

    public LinuxUpdatePlatform(string arch) => _arch = arch;

    public string Os => "linux";
    public string Arch => _arch;
    public string ExecutableName => "adgrmm-agent";
    public string InstallDir => Path.GetDirectoryName(Environment.ProcessPath) ?? "";
    public string StateDir => "/etc/adgrmm/update";

    public bool CanSelfUpdate(out string reason)
    {
        // A dev build run from another folder must never have that folder swapped out from under it.
        if (InstallDir != ExpectedInstallDir)
        {
            reason = $"It is not running from {ExpectedInstallDir}.";
            return false;
        }
        if (!File.Exists($"/etc/systemd/system/{ServiceName}.service") && !File.Exists($"/etc/init.d/{ServiceName}"))
        {
            reason = "It is not installed as a systemd or OpenRC service.";
            return false;
        }
        reason = "";
        return true;
    }

    public async Task ExtractAsync(string packagePath, string targetDir, CancellationToken ct)
    {
        await using var file = File.OpenRead(packagePath);
        await using var gz = new GZipStream(file, CompressionMode.Decompress);

        // TarFile refuses entries that would land outside the target folder.
        await TarFile.ExtractToDirectoryAsync(gz, targetDir, overwriteFiles: true, ct);

        // The package may be built on Windows, where tar has no execute bit to record.
        const UnixFileMode Executable = UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
            | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute;
        // The package carries a glibc program and a musl program. Whichever this one is keeps the name the service starts.
        var musl = Path.Combine(targetDir, MuslExecutableName);
        if (File.Exists(musl))
        {
            if (LinuxInit.IsMusl) File.Move(musl, Path.Combine(targetDir, ExecutableName), overwrite: true);
            else File.Delete(musl);
        }
        foreach (var name in new[] { ExecutableName, "uninstall.sh" })
        {
            var path = Path.Combine(targetDir, name);
            if (File.Exists(path)) File.SetUnixFileMode(path, Executable);
        }
    }

    public void LaunchApply(string targetVersion)
    {
        Directory.CreateDirectory(StateDir);

        string script;
        using (var res = Assembly.GetExecutingAssembly().GetManifestResourceStream(ScriptResource)
            ?? throw new InvalidOperationException("The apply script is missing from this build."))
        using (var reader = new StreamReader(res))
        {
            // A checkout on Windows may have turned the line endings into ones bash cannot read.
            script = reader.ReadToEnd().Replace("\r\n", "\n");
        }

        var scriptPath = Path.Combine(StateDir, "apply-update.sh");
        File.WriteAllText(scriptPath, script, new UTF8Encoding(false));

        File.WriteAllText(Path.Combine(StateDir, "apply-params.env"), string.Join('\n', new[]
        {
            $"INSTALL_DIR={Quote(InstallDir)}",
            $"STATE_DIR={Quote(StateDir)}",
            $"TARGET_VERSION={Quote(targetVersion)}",
            $"SERVICE_NAME={Quote(ServiceName)}",
            $"UPDATE_UNIT={Quote(LinuxInit.IsOpenRc ? OpenRcUpdateService : UpdateUnit)}",
            $"INIT={Quote(LinuxInit.IsOpenRc ? "openrc" : "systemd")}",
            $"EXE_NAME={Quote(ExecutableName)}",
            "HEALTH_SECONDS=300",
            "",
        }), new UTF8Encoding(false));

        if (LinuxInit.IsOpenRc)
        {
            // OpenRC: a one-shot service, enabled so it also runs at boot to repair an interrupted swap, started in a session of its own
            // because stopping the agent must not take the updater down with it.
            var initScript = $"/etc/init.d/{OpenRcUpdateService}";
            File.WriteAllText(initScript, OpenRcUpdateScript(scriptPath), new UTF8Encoding(false));
            File.SetUnixFileMode(initScript, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead | UnixFileMode.GroupExecute | UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
            RunTool("rc-update", "add", OpenRcUpdateService, "default");
            Detach($"setsid rc-service {OpenRcUpdateService} start >/dev/null 2>&1 &");
            return;
        }

        // A real unit rather than a child process: stopping the agent kills its cgroup, and being
        // enabled means it also runs at boot to repair a swap that a power cut interrupted.
        File.WriteAllText($"/etc/systemd/system/{UpdateUnit}", UnitFile(scriptPath), new UTF8Encoding(false));

        RunChecked("daemon-reload");
        RunChecked("enable", UpdateUnit);
        RunChecked("start", "--no-block", UpdateUnit);
    }

    public static string OpenRcUpdateScript(string scriptPath) => string.Join('\n', new[]
    {
        "#!/sbin/openrc-run",
        "description=\"ADG RMM Agent update\"",
        "",
        "depend() {",
        "\tneed localmount",
        "}",
        "",
        "start() {",
        "\tebegin \"Applying a ADG RMM agent update\"",
        $"\t/bin/bash {scriptPath}",
        "\teend $?",
        "}",
        "",
    });

    private static void Detach(string shellLine)
    {
        var psi = new ProcessStartInfo("sh") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        psi.ArgumentList.Add("-c");
        psi.ArgumentList.Add(shellLine);
        using var p = Process.Start(psi) ?? throw new InvalidOperationException("Could not start the updater.");
        p.WaitForExit(10_000);
    }

    public static string UnitFile(string scriptPath) => string.Join('\n', new[]
    {
        "[Unit]",
        "Description=ADG RMM Agent update",
        "",
        "[Service]",
        "Type=oneshot",
        $"ExecStart=/bin/bash {scriptPath}",
        "TimeoutStartSec=1800",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    });

    private static string Quote(string value) => "'" + value.Replace("'", "'\\''") + "'";

    private static void RunChecked(params string[] args) => RunTool("systemctl", args);

    private static void RunTool(string tool, params string[] args)
    {
        var psi = new ProcessStartInfo(tool)
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi) ?? throw new InvalidOperationException($"Could not run {tool}.");
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(30_000))
        {
            try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
            throw new InvalidOperationException($"{tool} {string.Join(' ', args)} did not finish.");
        }
        if (p.ExitCode != 0)
            throw new InvalidOperationException($"{tool} {string.Join(' ', args)} failed: {stderr.GetAwaiter().GetResult().Trim()}");
    }
}
