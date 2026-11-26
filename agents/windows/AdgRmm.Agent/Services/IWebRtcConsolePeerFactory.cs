// agents/windows/AdgRmm.Agent/Services/IWebRtcConsolePeerFactory.cs

namespace AdgRmm.Agent.Services;

/// <summary>A STUN or TURN server for one session, as issued by the backend.</summary>
public sealed record ConsoleIceServer(string Url, string? Username, string? Credential);

public interface IWebRtcConsolePeerFactory
{
    IWebRtcConsolePeer Create(string sessionId, IReadOnlyList<ConsoleIceServer>? iceServers = null);
}
