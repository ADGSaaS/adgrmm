using System.Diagnostics;
using System.Text;

namespace RemoteIQ.Agent.Services;

public sealed class ScriptExecutor
{
    private const int MaxOutputChars = 200_000;

    public async Task<(int exitCode, string stdout, string stderr, long durationMs, string status)> RunPowerShellAsync(
        string scriptText,
        string[] args,
        IDictionary<string, string> env,
        int timeoutSec,
        CancellationToken ct)
    {
        var sw = Stopwatch.StartNew();

        // The script runs as SYSTEM, so it is written where only SYSTEM and Administrators can change it (not the shared temp
        // folder, which a user could prepare beforehand), under a random name that must not exist yet.
        var scriptDir = PrivateFolders.JobsDir(out var temporaryDir);
        var scriptPath = Path.Combine(scriptDir, $"job-{Guid.NewGuid():N}.ps1");

        try
        {
            await using (var f = new FileStream(scriptPath, FileMode.CreateNew, FileAccess.Write, FileShare.Read))
            await using (var w = new StreamWriter(f, Encoding.UTF8))
            {
                await w.WriteAsync((scriptText ?? "").AsMemory(), ct);
            }

            var psi = new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = BuildPsArgs(scriptPath, args),
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                RedirectStandardInput = false,
                CreateNoWindow = true,
            };

            foreach (var kv in env)
            {
                if (string.IsNullOrWhiteSpace(kv.Key)) continue;
                psi.Environment[kv.Key] = kv.Value ?? "";
            }

            using var p = new Process { StartInfo = psi, EnableRaisingEvents = true };

            p.Start();

            var stdoutTask = p.StandardOutput.ReadToEndAsync();
            var stderrTask = p.StandardError.ReadToEndAsync();

            var exited = p.WaitForExitAsync(ct);
            var finished = await Task.WhenAny(
                exited,
                Task.Delay(TimeSpan.FromSeconds(Math.Clamp(timeoutSec, 1, 3600)), ct)
            );

            if (finished != exited)
            {
                TryKill(p);
                var so = Trunc(await SafeString(stdoutTask), MaxOutputChars);
                var se = Trunc(await SafeString(stderrTask), MaxOutputChars);
                sw.Stop();
                return (-1, so, se + "\nTIMEOUT", sw.ElapsedMilliseconds, "timeout");
            }

            var stdout = Trunc(await SafeString(stdoutTask), MaxOutputChars);
            var stderr = Trunc(await SafeString(stderrTask), MaxOutputChars);

            sw.Stop();
            var code = p.ExitCode;
            var status = code == 0 ? "succeeded" : "failed";
            return (code, stdout, stderr, sw.ElapsedMilliseconds, status);
        }
        finally
        {
            try { File.Delete(scriptPath); } catch { /* ignore */ }
            if (temporaryDir) { try { Directory.Delete(scriptDir, recursive: true); } catch { /* ignore */ } }
        }
    }

    private static string BuildPsArgs(string scriptPath, string[] args)
    {
        // PowerShell will receive args in $args
        var sb = new StringBuilder();
        sb.Append("-NoProfile -NonInteractive -ExecutionPolicy Bypass ");
        sb.Append("-File ");
        sb.Append('"').Append(scriptPath.Replace("\"", "\\\"")).Append('"');

        foreach (var a in args ?? Array.Empty<string>())
        {
            sb.Append(' ').Append('"').Append((a ?? "").Replace("\"", "\\\"")).Append('"');
        }

        return sb.ToString();
    }

    private static void TryKill(Process p)
    {
        try
        {
            if (!p.HasExited)
            {
                // Kill entire process tree when possible
                p.Kill(entireProcessTree: true);
            }
        }
        catch { /* ignore */ }
    }

    private static async Task<string> SafeString(Task<string> t)
    {
        try { return await t; }
        catch { return ""; }
    }

    private static string Trunc(string s, int maxChars)
    {
        if (string.IsNullOrEmpty(s)) return "";
        return s.Length <= maxChars ? s : s.Substring(0, maxChars) + "\n<TRUNCATED>";
    }
}
