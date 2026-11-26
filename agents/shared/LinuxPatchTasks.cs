// The signed task protocol as the Linux agent speaks it, and what patch_scan and patch_install report back.
//
// The server hands out tasks from POST /api/agent/tasks/next as { task, run, signed: { payload, sig } }. The signature is
// the server's job-signing key over { taskId, type, payload, agentId, iat }. Nothing runs unless it verifies and is for
// this agent, exactly as for the Windows agent, and only the signed bytes are ever read.
using System.Security.Cryptography;
using System.Text.Json;

namespace AdgRmm.Agent.Shared;

public sealed class OpenedTask
{
    public string TaskId { get; init; } = "";
    public string Type { get; init; } = "";
    public JsonElement Payload { get; init; }

    public string? ReadString(string name) =>
        Payload.ValueKind == JsonValueKind.Object && Payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public bool ReadBool(string name, bool fallback = false) =>
        Payload.ValueKind == JsonValueKind.Object && Payload.TryGetProperty(name, out var v)
            ? v.ValueKind switch { JsonValueKind.True => true, JsonValueKind.False => false, JsonValueKind.String => bool.TryParse(v.GetString(), out var b) ? b : fallback, _ => fallback }
            : fallback;

    public int? ReadInt(string name) =>
        Payload.ValueKind == JsonValueKind.Object && Payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

    public string[] ReadStrings(string name) =>
        Payload.ValueKind == JsonValueKind.Object && Payload.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Select(x => x.ValueKind == JsonValueKind.String ? x.GetString() : x.ToString()).Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!.Trim()).ToArray()
            : Array.Empty<string>();
}

public static class AgentTaskEnvelope
{
    public static readonly TimeSpan MaxAge = TimeSpan.FromMinutes(15);

    /// <summary>Opens a task. The id and type in the unsigned part of the response must match the signed ones.</summary>
    public static bool TryOpen(string? payloadB64, string? sigB64, string? publicKeyPem, string agentId, string claimedTaskId, string claimedType, DateTimeOffset now, out OpenedTask? task, out string reason)
    {
        task = null;
        if (string.IsNullOrWhiteSpace(publicKeyPem)) { reason = "This agent has no job signing key. Run the installer again."; return false; }
        if (string.IsNullOrEmpty(payloadB64) || string.IsNullOrEmpty(sigB64)) { reason = "The task is not signed."; return false; }

        try
        {
            var bytes = Convert.FromBase64String(payloadB64);
            using var rsa = RSA.Create();
            rsa.ImportFromPem(publicKeyPem);
            if (!rsa.VerifyData(bytes, Convert.FromBase64String(sigB64), HashAlgorithmName.SHA256, RSASignaturePadding.Pss))
            {
                reason = "The task's signature is invalid.";
                return false;
            }

            using var doc = JsonDocument.Parse(bytes);
            var root = doc.RootElement;
            string? Get(string n) => root.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

            if (!string.Equals(Get("agentId"), agentId, StringComparison.OrdinalIgnoreCase)) { reason = "The task was signed for a different agent."; return false; }

            var issued = root.TryGetProperty("iat", out var i) && i.TryGetInt64(out var ms) ? DateTimeOffset.FromUnixTimeMilliseconds(ms) : DateTimeOffset.MinValue;
            if ((now - issued).Duration() > MaxAge) { reason = "The task's signature has expired. Check this device's clock."; return false; }

            var id = Get("taskId");
            var type = Get("type");
            if (string.IsNullOrEmpty(id) || id != claimedTaskId || string.IsNullOrEmpty(type) || type != claimedType) { reason = "The signed task details do not match."; return false; }

            task = new OpenedTask
            {
                TaskId = id,
                Type = type,
                Payload = root.TryGetProperty("payload", out var p) && p.ValueKind == JsonValueKind.Object ? p.Clone() : default,
            };
            reason = "";
            return true;
        }
        catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException)
        {
            reason = "The task could not be read: " + ex.Message;
            return false;
        }
    }
}

/// <summary>What the server stores for a finished patch task. The shapes match the Windows agent's, plus the extra fields.</summary>
public static class LinuxPatchReport
{
    private const int StdoutLimit = 16_000;

    public static object ScanArtifacts(LinuxScanResult scan) => new
    {
        packageManager = scan.Manager.ToString().ToLowerInvariant(),
        patches = scan.Patches.Select(p => new
        {
            id = p.Id,
            title = p.Title,
            severity = p.Severity,
            requiresReboot = p.RequiresReboot,
            kbIds = p.Advisories,
            security = p.Security,
            name = p.Name,
            current = p.Current,
            available = p.Available,
            source = p.Source,
        }).ToList(),
        skipped = scan.Skipped.Select(s => new { id = s.Id, reason = s.Reason }).ToList(),
        rebootRequired = scan.RebootRequired,
        rebootReason = scan.RebootReason,
    };

    public static string ScanStdout(LinuxScanResult scan)
    {
        var sec = scan.Patches.Count(p => p.Security);
        var head = $"Found {scan.Patches.Count} available update(s), {sec} of them security updates ({scan.Manager.ToString().ToLowerInvariant()}).";
        if (scan.Skipped.Count > 0) head += $" {scan.Skipped.Count} package(s) are not being offered (held, kept back or phased).";
        if (scan.RebootRequired) head += " A restart is needed.";
        return head + "\n\n" + LinuxPatchParsers.Truncate(scan.Log, StdoutLimit);
    }

    public static object InstallArtifacts(LinuxInstallResult r, LinuxPackageManager manager) => new
    {
        packageManager = manager.ToString().ToLowerInvariant(),
        installed = r.Installed,
        failed = r.Failed,
        skipped = r.Skipped.Select(s => new { id = s.Id, reason = s.Reason }).ToList(),
        requiresReboot = r.RebootRequired,
    };

    public static string InstallStdout(LinuxInstallResult r) => r.Message + "\n\n" + LinuxPatchParsers.Truncate(r.Log, StdoutLimit);
}
