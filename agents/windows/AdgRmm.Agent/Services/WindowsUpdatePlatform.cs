using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Security;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Hosting.WindowsServices;
using AdgRmm.Agent.Shared;

namespace AdgRmm.Agent.Services;

public sealed class WindowsUpdatePlatform : IUpdatePlatform
{
    private const string TaskName = "ADG RMM Agent Update";
    private const string ServiceName = "AdgRmmAgent";
    private const string ScriptResource = "AdgRmm.Agent.apply-update.ps1";

    public string Os => "windows";
    public string Arch => Environment.Is64BitOperatingSystem ? "x64" : "x86";
    public string ExecutableName => "AdgRmm.Agent.exe";

    // AppContext.BaseDirectory is a temporary extraction folder in a single-file app.
    public string InstallDir => Path.GetDirectoryName(Environment.ProcessPath) ?? "";

    public string StateDir => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "AdgRmm", "update");

    public bool CanSelfUpdate(out string reason)
    {
        // A dev build run from a bin folder must never have that folder swapped out from under it.
        if (!WindowsServiceHelpers.IsWindowsService())
        {
            reason = "It is not running as the Windows service.";
            return false;
        }
        if (!string.Equals(Path.GetFileName(Environment.ProcessPath), ExecutableName, StringComparison.OrdinalIgnoreCase))
        {
            reason = "It is not running from the installed executable.";
            return false;
        }
        reason = "";
        return true;
    }

    public Task ExtractAsync(string packagePath, string targetDir, CancellationToken ct)
    {
        // ZipFile refuses entries that would land outside the target folder.
        ZipFile.ExtractToDirectory(packagePath, targetDir, overwriteFiles: true);
        return Task.CompletedTask;
    }

    public void LaunchApply(string targetVersion)
    {
        // The apply script runs as SYSTEM, so it is only written where nobody but SYSTEM and Administrators can change it.
        // (The data folder above it holds the agent's config and is locked down by the installer; it is not checked here, so that an
        // install whose data folder is owned by the administrator who ran the installer can still update.)
        if (!PrivateFolders.TryEnsureLockedDown(StateDir))
            throw new InvalidOperationException("The update folder is not limited to SYSTEM and Administrators, so the update was not applied. Reinstall the agent to fix its folder permissions.");

        var scriptPath = Path.Combine(StateDir, "apply-update.ps1");
        using (var res = Assembly.GetExecutingAssembly().GetManifestResourceStream(ScriptResource)
            ?? throw new InvalidOperationException("The apply script is missing from this build."))
        using (var file = File.Create(scriptPath))
        {
            res.CopyTo(file);
        }

        File.WriteAllText(Path.Combine(StateDir, "apply-params.json"), JsonSerializer.Serialize(new
        {
            installDir = InstallDir,
            stateDir = StateDir,
            targetVersion,
            serviceName = ServiceName,
            taskName = TaskName,
            exeName = ExecutableName,
            healthSeconds = 300,
        }), new UTF8Encoding(false));

        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var arguments = $"-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"{scriptPath}\"";

        // A scheduled task also runs at boot, so a power cut in the middle of the swap gets repaired.
        var xmlPath = Path.Combine(StateDir, "apply-task.xml");
        File.WriteAllText(xmlPath, TaskXml(powershell, arguments), new UnicodeEncoding(false, true));

        if (RunQuietly("schtasks.exe", "/Create", "/F", "/TN", TaskName, "/XML", xmlPath) == 0 &&
            RunQuietly("schtasks.exe", "/Run", "/TN", TaskName) == 0)
        {
            return;
        }

        // Without a task there is no repair at boot, but the update and its rollback still work.
        var psi = new ProcessStartInfo(powershell, arguments) { UseShellExecute = false, CreateNoWindow = true };
        using var started = Process.Start(psi) ?? throw new InvalidOperationException("Could not start the apply script.");
    }

    // The defaults stop a task on battery power, which would strand an update on a laptop.
    public static string TaskXml(string command, string arguments) => $"""
        <?xml version="1.0" encoding="UTF-16"?>
        <Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
          <RegistrationInfo><Description>Finishes or repairs a ADG RMM agent update. It removes itself afterwards.</Description></RegistrationInfo>
          <Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>
          <Principals><Principal id="System"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
          <Settings>
            <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
            <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
            <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
            <AllowHardTerminate>true</AllowHardTerminate>
            <StartWhenAvailable>true</StartWhenAvailable>
            <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
            <AllowStartOnDemand>true</AllowStartOnDemand>
            <Enabled>true</Enabled>
            <Hidden>false</Hidden>
            <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
            <Priority>7</Priority>
          </Settings>
          <Actions Context="System"><Exec><Command>{SecurityElement.Escape(command)}</Command><Arguments>{SecurityElement.Escape(arguments)}</Arguments></Exec></Actions>
        </Task>
        """;

    private static int RunQuietly(string file, params string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(file)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var p = Process.Start(psi);
            if (p is null) return -1;
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(30_000))
            {
                try { p.Kill(entireProcessTree: true); } catch { /* already gone */ }
                return -1;
            }
            return p.ExitCode;
        }
        catch
        {
            return -1;
        }
    }
}
