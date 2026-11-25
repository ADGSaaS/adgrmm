// agents/windows/RemoteIQ.Agent/Services/ConsoleVideoCodecs.cs

using System.Collections.Concurrent;
using System.Text;
using System.Text.RegularExpressions;

namespace RemoteIQ.Agent.Services;

/// <summary>The "Remote video codec" setting: what a customer (or the whole system) allows.</summary>
public enum ConsoleVideoCodecSetting
{
    /// <summary>VP8, unless this device has a hardware H.264 encoder that passed the start-up check.</summary>
    Auto,

    /// <summary>VP8 always.</summary>
    Vp8,

    /// <summary>H.264 when the device can encode it (hardware or Windows' software encoder) and the browser can decode it, else VP8.</summary>
    H264,
}

/// <summary>Where the setting comes from and how it is read. Anything unrecognised means Auto, which is safe: Auto only ever picks H.264 on a proven hardware encoder.</summary>
public static class ConsoleVideoPolicy
{
    private static readonly ConcurrentDictionary<string, ConsoleVideoCodecSetting> PerSession = new();

    public static ConsoleVideoCodecSetting Parse(string? text) => (text ?? "").Trim().ToLowerInvariant() switch
    {
        "vp8" => ConsoleVideoCodecSetting.Vp8,
        "h264" or "h.264" => ConsoleVideoCodecSetting.H264,
        _ => ConsoleVideoCodecSetting.Auto,
    };

    /// <summary>
    /// The server's choice reaches the peer through here, keyed by session, because the peer is made by a factory
    /// that other implementations share. A session with no entry gets Auto.
    /// </summary>
    public static void SetForSession(string sessionId, ConsoleVideoCodecSetting setting) => PerSession[sessionId] = setting;

    public static ConsoleVideoCodecSetting TakeForSession(string sessionId)
        => PerSession.TryRemove(sessionId, out var setting) ? setting : ConsoleVideoCodecSetting.Auto;

    public static void Forget(string sessionId) => PerSession.TryRemove(sessionId, out _);

    /// <summary>
    /// A switch on the device itself, REMOTE_CONSOLE_VIDEO_CODEC, which can only make things more conservative:
    /// "vp8" overrides whatever the server says, so a device can be kept on VP8 without touching the server.
    /// </summary>
    public static ConsoleVideoCodecSetting Effective(ConsoleVideoCodecSetting fromServer, string? deviceOverride)
        => Parse(deviceOverride) == ConsoleVideoCodecSetting.Vp8 && !string.IsNullOrWhiteSpace(deviceOverride)
            ? ConsoleVideoCodecSetting.Vp8
            : fromServer;
}

/// <summary>What the start-up check found out about H.264 on this device.</summary>
public sealed record H264Capability(bool Available, bool Hardware, string Name, int CandidateIndex, string Detail)
{
    public static readonly H264Capability None = new(false, false, "", -1, "no H.264 encoder passed the start-up check");
}

/// <summary>
/// Whether this device can encode H.264, found once per run of the agent by a short test in a separate process,
/// because a graphics driver that misbehaves must not be able to take the agent down with it. A failure found
/// later, during a session, is remembered here too, so the rest of the run stays on VP8.
/// </summary>
public static class H264Support
{
    private static readonly object Gate = new();
    private static Task<H264Capability>? _probe;
    private static volatile H264Capability? _result;
    private static volatile string? _failedLater;

    /// <summary>The check's result, or null while it has not finished (or was not started). Never blocks.</summary>
    public static H264Capability? Cached => _failedLater is null ? _result : H264Capability.None with { Detail = _failedLater };

    /// <summary>Starts the check once, and returns the same task to everyone who asks.</summary>
    public static Task<H264Capability> ProbeAsync(Func<Task<H264Capability>> run)
    {
        lock (Gate)
        {
            return _probe ??= Task.Run(async () =>
            {
                H264Capability result;
                try { result = await run().ConfigureAwait(false); }
                catch (Exception ex) { result = H264Capability.None with { Detail = "the start-up check failed: " + ex.Message }; }
                _result = result;
                return result;
            });
        }
    }

    /// <summary>Remembers that H.264 failed in a real session, so no later session in this run tries it.</summary>
    public static void MarkFailed(string reason) => _failedLater ??= reason;

    public static string? FailureLater => _failedLater;

    /// <summary>For tests: forgets everything.</summary>
    public static void ResetForTests()
    {
        lock (Gate)
        {
            _probe = null;
            _result = null;
            _failedLater = null;
        }
    }

    /// <summary>For tests: pretends the check finished with this result.</summary>
    public static void SetResultForTests(H264Capability? capability)
    {
        _result = capability;
    }
}

/// <summary>One H.264 entry of a browser's offer.</summary>
public sealed record OfferedH264(int PayloadType, string ProfileLevelId, int PacketizationMode, string Fmtp);

/// <summary>The codecs of a browser's video offer that matter here.</summary>
public sealed record OfferedVideo(int? Vp8PayloadType, IReadOnlyList<OfferedH264> H264);

/// <summary>What is going to be sent, and how the answer must describe it.</summary>
public sealed record ConsoleCodecDecision(ConsoleVideoCodec Codec, int? Vp8PayloadType, OfferedH264? H264, string Reason);

public static class ConsoleCodecNegotiation
{
    private static readonly Regex RtpMap = new(@"^a=rtpmap:(\d+)\s+([A-Za-z0-9\-]+)/(\d+)", RegexOptions.Compiled);
    private static readonly Regex Fmtp = new(@"^a=fmtp:(\d+)\s+(.*)$", RegexOptions.Compiled);

    private static IEnumerable<string> Lines(string sdp) => sdp.Replace("\r\n", "\n").Split('\n').Select(l => l.TrimEnd('\r'));

    private static (int Start, int End, List<string> Lines)? VideoSection(string sdp)
    {
        var lines = Lines(sdp).ToList();
        var start = lines.FindIndex(l => l.StartsWith("m=video ", StringComparison.Ordinal));
        if (start < 0) return null;
        var end = lines.FindIndex(start + 1, l => l.StartsWith("m=", StringComparison.Ordinal));
        return (start, end < 0 ? lines.Count : end, lines);
    }

    /// <summary>Reads VP8 and H.264 out of the first video section of an offer.</summary>
    public static OfferedVideo ParseOffer(string sdp)
    {
        int? vp8 = null;
        var h264 = new List<OfferedH264>();
        if (VideoSection(sdp) is not { } section) return new OfferedVideo(null, h264);

        var fmtp = new Dictionary<int, string>();
        var names = new List<(int Pt, string Name)>();
        for (var i = section.Start; i < section.End; i++)
        {
            var line = section.Lines[i];
            if (RtpMap.Match(line) is { Success: true } rm && int.TryParse(rm.Groups[1].Value, out var pt))
                names.Add((pt, rm.Groups[2].Value));
            else if (Fmtp.Match(line) is { Success: true } fm && int.TryParse(fm.Groups[1].Value, out var fpt))
                fmtp[fpt] = fm.Groups[2].Value;
        }

        foreach (var (pt, name) in names)
        {
            if (name.Equals("VP8", StringComparison.OrdinalIgnoreCase)) vp8 ??= pt;
            else if (name.Equals("H264", StringComparison.OrdinalIgnoreCase))
            {
                var parameters = fmtp.TryGetValue(pt, out var text) ? text : "";
                var map = ParseParameters(parameters);
                // Without a profile-level-id the default is baseline level 1, and without packetization-mode it is mode 0 (RFC 6184).
                var mode = map.TryGetValue("packetization-mode", out var m) && int.TryParse(m, out var parsed) ? parsed : 0;
                var profile = map.TryGetValue("profile-level-id", out var p) ? p.ToLowerInvariant() : "42000a";
                h264.Add(new OfferedH264(pt, profile, mode, parameters));
            }
        }
        return new OfferedVideo(vp8, h264);
    }

    private static Dictionary<string, string> ParseParameters(string text)
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var part in text.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var eq = part.IndexOf('=');
            if (eq > 0) map[part[..eq].Trim()] = part[(eq + 1)..].Trim();
        }
        return map;
    }

    /// <summary>
    /// The H.264 entry the encoder's output can be sent under: non-interleaved packetization (mode 1, the only one the
    /// packetizer makes), and a profile the stream is decodable in. The stream is Constrained Baseline, which every
    /// decoder of Baseline, Main or High takes, so those three profiles qualify.
    /// </summary>
    public static OfferedH264? PickH264(OfferedVideo offer)
    {
        OfferedH264? best = null;
        var bestScore = -1;
        foreach (var entry in offer.H264)
        {
            if (entry.PacketizationMode != 1) continue;
            if (entry.ProfileLevelId.Length != 6) continue;
            var profile = entry.ProfileLevelId[..2];
            var score = profile switch
            {
                "42" when entry.ProfileLevelId.StartsWith("42e0", StringComparison.Ordinal) => 4, // Constrained Baseline: what WebRTC requires everywhere
                "42" => 3,
                "4d" => 2,
                "64" => 1,
                _ => -1,
            };
            if (score > bestScore)
            {
                best = entry;
                bestScore = score;
            }
        }
        return best;
    }

    /// <summary>
    /// The one place that decides. H.264 needs all of: the setting allows it, the start-up check passed (and for Auto,
    /// on hardware), and the browser offered a form of it that can be sent. Anything else is VP8.
    /// </summary>
    public static ConsoleCodecDecision Decide(ConsoleVideoCodecSetting setting, H264Capability? capability, OfferedVideo offer)
    {
        var vp8 = offer.Vp8PayloadType;
        if (setting == ConsoleVideoCodecSetting.Vp8) return new ConsoleCodecDecision(ConsoleVideoCodec.Vp8, vp8, null, "the setting is VP8");
        if (capability is not { Available: true }) return new ConsoleCodecDecision(ConsoleVideoCodec.Vp8, vp8, null, capability is null ? "the H.264 start-up check has not finished" : capability.Detail);
        if (setting == ConsoleVideoCodecSetting.Auto && !capability.Hardware) return new ConsoleCodecDecision(ConsoleVideoCodec.Vp8, vp8, null, "Auto uses H.264 only on a hardware encoder, and this device has only a software one");

        var pick = PickH264(offer);
        if (pick is null) return new ConsoleCodecDecision(ConsoleVideoCodec.Vp8, vp8, null, "the browser did not offer H.264 in a form that can be sent");

        return new ConsoleCodecDecision(ConsoleVideoCodec.H264, vp8, pick,
            $"{(capability.Hardware ? "hardware" : "software")} encoder {capability.Name}, setting {setting}");
    }

    /// <summary>
    /// Makes the video part of an answer say what will really be sent: H.264 (under the browser's own payload type and
    /// parameters) when it was chosen, with VP8 kept after it so that the picture can fall back to VP8 mid-session, and
    /// otherwise nothing but VP8, which is what every answer was before H.264 existed. Everything else in the answer is kept.
    /// </summary>
    public static string ApplyToAnswer(string answer, ConsoleCodecDecision decision)
    {
        if (decision.Codec == ConsoleVideoCodec.Vp8 && decision.H264 is null && !ContainsH264(answer)) return answer;
        if (VideoSection(answer) is not { } section) return answer;

        var lines = section.Lines;
        var header = lines[section.Start].Split(' ', StringSplitOptions.RemoveEmptyEntries).ToList();
        if (header.Count < 4) return answer;

        // Payload types the answer already names, and what each one is.
        var names = new Dictionary<string, string>();
        for (var i = section.Start; i < section.End; i++)
        {
            if (RtpMap.Match(lines[i]) is { Success: true } m) names[m.Groups[1].Value] = m.Groups[2].Value.ToUpperInvariant();
        }

        string? vp8Pt = decision.Vp8PayloadType?.ToString() ?? names.FirstOrDefault(kv => kv.Value == "VP8").Key;
        var keep = new List<string>();
        if (decision.Codec == ConsoleVideoCodec.H264 && decision.H264 is { } h264) keep.Add(h264.PayloadType.ToString());
        if (vp8Pt is not null) keep.Add(vp8Pt);
        if (keep.Count == 0) return answer;

        var rebuilt = new List<string>();
        var codecLines = new List<string>();
        foreach (var pt in keep)
        {
            var isH264 = decision.H264 is { } h && pt == h.PayloadType.ToString() && decision.Codec == ConsoleVideoCodec.H264;
            codecLines.Add($"a=rtpmap:{pt} {(isH264 ? "H264" : "VP8")}/90000");
            codecLines.Add($"a=rtcp-fb:{pt} nack");
            codecLines.Add($"a=rtcp-fb:{pt} nack pli");
            codecLines.Add($"a=rtcp-fb:{pt} ccm fir");
            if (isH264) codecLines.Add($"a=fmtp:{pt} {decision.H264!.Fmtp}");
        }

        rebuilt.AddRange(lines.Take(section.Start));
        rebuilt.Add(string.Join(' ', header.Take(3).Concat(keep)));

        var inserted = false;
        for (var i = section.Start + 1; i < section.End; i++)
        {
            var line = lines[i];
            var isCodecLine = false;
            foreach (var prefix in new[] { "a=rtpmap:", "a=fmtp:", "a=rtcp-fb:" })
            {
                if (!line.StartsWith(prefix, StringComparison.Ordinal)) continue;
                var rest = line[prefix.Length..];
                var space = rest.IndexOf(' ');
                var pt = space > 0 ? rest[..space] : rest;
                // A wildcard feedback line applies to every payload type, so it stays.
                isCodecLine = pt != "*";
                break;
            }

            if (isCodecLine)
            {
                if (!inserted)
                {
                    rebuilt.AddRange(codecLines);
                    inserted = true;
                }
                continue;
            }
            rebuilt.Add(line);
        }
        if (!inserted) rebuilt.AddRange(codecLines);
        rebuilt.AddRange(lines.Skip(section.End));

        var result = new StringBuilder();
        foreach (var l in rebuilt.Where(l => l.Length > 0)) result.Append(l).Append("\r\n");
        return result.ToString();
    }

    private static bool ContainsH264(string sdp) => sdp.Contains("H264/", StringComparison.OrdinalIgnoreCase);
}
