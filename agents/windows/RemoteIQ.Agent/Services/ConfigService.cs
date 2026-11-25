using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using RemoteIQ.Agent.Models;

namespace RemoteIQ.Agent.Services;

public sealed class ConfigService
{
    private readonly IConfiguration _cfg;
    private readonly ILogger<ConfigService> _log;

    private readonly string _configPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "RemoteIQ", "agent.config.json");

    // Written by the installer, applied once, then deleted because it holds the key in clear text.
    private readonly string _enrollmentPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "RemoteIQ", "enrollment.json");

    private sealed class EnrollmentFile
    {
        public string? DeviceId { get; set; }
        public string? EnrollmentKey { get; set; }
        public string? BaseUrl { get; set; }
    }

    public AgentConfig Current { get; private set; }

    public ConfigService(IConfiguration cfg, ILogger<ConfigService> log)
    {
        _cfg = cfg;
        _log = log;

        Directory.CreateDirectory(Path.GetDirectoryName(_configPath)!);

        var defaults = new AgentConfig();
        _cfg.GetSection("RemoteIQ").Bind(defaults);

        Current = LoadOrInit(defaults);
        ApplyEnrollmentFile();
    }

    private void ApplyEnrollmentFile()
    {
        if (!File.Exists(_enrollmentPath)) return;

        try
        {
            var file = System.Text.Json.JsonSerializer.Deserialize<EnrollmentFile>(
                File.ReadAllText(_enrollmentPath, Encoding.UTF8),
                new System.Text.Json.JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (string.IsNullOrWhiteSpace(file?.BaseUrl) ||
                string.IsNullOrWhiteSpace(file.DeviceId) ||
                string.IsNullOrWhiteSpace(file.EnrollmentKey))
            {
                _log.LogError("enrollment.json is missing baseUrl, deviceId or enrollmentKey; ignoring it.");
                return;
            }

            var cfg = Current;
            cfg.ApiBaseUrl = file.BaseUrl.Trim();
            cfg.DeviceId = file.DeviceId.Trim();
            cfg.EnrollmentKey = file.EnrollmentKey.Trim();
            cfg.EnrollmentSecret = "";

            // Running the installer means enroll again, so the old token is dropped.
            cfg.AgentId = "";
            cfg.AgentKey = "";

            Save(cfg);
            File.Delete(_enrollmentPath);
            _log.LogInformation("Applied enrollment settings from the installer.");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to apply enrollment.json");
        }
    }

    private AgentConfig LoadOrInit(AgentConfig defaults)
    {
        if (!File.Exists(_configPath))
        {
            Save(defaults);
            return defaults;
        }

        AgentConfig cfg;
        try
        {
            var json = File.ReadAllText(_configPath, Encoding.UTF8);
            cfg = System.Text.Json.JsonSerializer.Deserialize<AgentConfig>(json) ?? defaults;
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "agent.config.json is unreadable; starting from defaults.");
            return defaults;
        }

        // DPAPI decrypt helpers
        cfg.AgentKey = TryDpapiUnprotect(cfg.AgentKey, "AgentKey");
        cfg.EnrollmentSecret = TryDpapiUnprotect(cfg.EnrollmentSecret, "EnrollmentSecret");
        cfg.EnrollmentKey = TryDpapiUnprotect(cfg.EnrollmentKey, "EnrollmentKey");

        return cfg;
    }

    private string TryDpapiUnprotect(string value, string label)
    {
        if (string.IsNullOrEmpty(value)) return "";

        if (!value.StartsWith("DPAPI:", StringComparison.Ordinal))
            return value;

        try
        {
            var b64 = value.Substring("DPAPI:".Length);
            var enc = Convert.FromBase64String(b64);
            var clear = ProtectedData.Unprotect(enc, null, DataProtectionScope.LocalMachine);
            return Encoding.UTF8.GetString(clear);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to decrypt {Label}; value will be cleared.", label);
            return "";
        }
    }

    private string ProtectIfNotEmpty(string clearText)
    {
        if (string.IsNullOrEmpty(clearText)) return "";
        var clear = Encoding.UTF8.GetBytes(clearText);
        var enc = ProtectedData.Protect(clear, null, DataProtectionScope.LocalMachine);
        return "DPAPI:" + Convert.ToBase64String(enc);
    }

    public void Save(AgentConfig cfg)
    {
        // Store only DPAPI-wrapped sensitive fields
        var toStore = new AgentConfig
        {
            ApiBaseUrl = cfg.ApiBaseUrl,
            AgentId = cfg.AgentId,
            AgentGroup = cfg.AgentGroup,
            DeviceId = cfg.DeviceId,

            PollIntervals = cfg.PollIntervals,
            Security = cfg.Security,

            AgentKey = ProtectIfNotEmpty(cfg.AgentKey),
            EnrollmentSecret = ProtectIfNotEmpty(cfg.EnrollmentSecret),
            EnrollmentKey = ProtectIfNotEmpty(cfg.EnrollmentKey),
        };

        var json = System.Text.Json.JsonSerializer.Serialize(toStore, new System.Text.Json.JsonSerializerOptions
        {
            WriteIndented = true
        });

        // Replace in one step, so a power cut cannot leave a half-written config and lose the agent's identity.
        var tmp = _configPath + ".tmp";
        File.WriteAllText(tmp, json, Encoding.UTF8);
        File.Move(tmp, _configPath, overwrite: true);
        Current = cfg;
    }
}
