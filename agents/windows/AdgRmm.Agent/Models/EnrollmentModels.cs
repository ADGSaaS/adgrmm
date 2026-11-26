namespace AdgRmm.Agent.Models;

public sealed class EnrollmentRequest
{
    // Exactly one of these is sent; the backend rejects empty values.
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? EnrollmentSecret { get; set; }

    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public string? EnrollmentKey { get; set; }

    public string DeviceId { get; set; } = "";
    public string Hostname { get; set; } = "";
    public string Os { get; set; } = "windows";
    public string Arch { get; set; } = "x64";
    public string Version { get; set; } = "1.0.0";
}

public sealed class EnrollmentResponse
{
    public string AgentId { get; set; } = "";
    public string AgentToken { get; set; } = "";
    public string DeviceId { get; set; } = "";
    public string? AgentUuid { get; set; } = null;

    // The server's key. Every job the agent runs must be signed with its private half.
    public string? JobSigningPublicKey { get; set; } = null;
}
