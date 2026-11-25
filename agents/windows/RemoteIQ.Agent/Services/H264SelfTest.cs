// agents/windows/RemoteIQ.Agent/Services/H264SelfTest.cs

using System.Diagnostics;
using System.Text.Json;

namespace RemoteIQ.Agent.Services;

/// <summary>
/// The start-up check: H.264 is offered only if an encoder of this device produces correct output here, now.
/// It runs in a child process ("RemoteIQ.Agent.exe --h264-selftest") so that a driver which hangs or crashes
/// costs nothing but that process, and with a time limit.
/// </summary>
public static class H264SelfTest
{
    public const string Argument = "--h264-selftest";
    private const string Marker = "H264SELFTEST ";
    private const int Width = 1280;
    private const int Height = 720;
    private const int Frames = 30;
    private const int ForcedKeyframeAt = 15;
    private const double MaxAverageMs = 45;

    /// <summary>Tries each encoder in turn, hardware first, and reports the first that passes (and whether a software one would).</summary>
    public static H264Capability RunHere(Action<string>? log = null)
    {
        var candidates = MfH264Encoder.Enumerate();
        if (candidates.Count == 0) return H264Capability.None with { Detail = "Windows offers no H.264 encoder" };

        H264Capability? firstGood = null;
        var notes = new List<string>();
        var failedNames = new HashSet<string>();
        for (var i = 0; i < candidates.Count; i++)
        {
            var candidate = candidates[i];

            // A machine lists several entries with the same name for one adapter. If the first of them failed, so will the rest,
            // and each failure costs seconds, so they are not tried.
            if (failedNames.Contains(candidate.Name)) continue;
            var problem = TestOne(candidate);
            if (problem is not null) failedNames.Add(candidate.Name);
            log?.Invoke($"{candidate}: {(problem is null ? "passed" : "failed: " + problem)}");
            notes.Add($"{candidate}: {(problem is null ? "ok" : problem)}");
            if (problem is null && firstGood is null)
            {
                firstGood = new H264Capability(true, candidate.Hardware, candidate.Name, i, "");
                // Enumeration lists hardware first, so a passing encoder here is the best there is.
                break;
            }
        }

        return (firstGood ?? H264Capability.None) with { Detail = string.Join("; ", notes) };
    }

    /// <returns>null when the encoder passed, otherwise what went wrong.</returns>
    public static string? TestOne(MfH264Candidate candidate)
    {
        var picture = 0;
        try
        {
            using var encoder = new MfH264Encoder(candidate, 2000, 30) { Trace = m => { if (Environment.GetEnvironmentVariable("H264TRACE") == "1") Console.WriteLine("  trace: " + m); } };
            var frame = new byte[Width * Height * 4];
            for (var i = 0; i < frame.Length; i += 4)
            {
                var x = (i / 4) % Width;
                var y = (i / 4) / Width;
                frame[i] = (byte)(x / 5);
                frame[i + 1] = (byte)(y / 3);
                frame[i + 2] = 90;
                frame[i + 3] = 255;
            }

            var outputs = 0;
            double totalMs = 0;
            var firstChecked = false;
            var forcedSeen = false;
            var sinceForce = -1;
            var preparer = new H264Packetizer.Preparer();

            for (var n = 0; n < Frames; n++)
            {
                picture = n;
                // Something different in every frame, since an unchanged one is not encoded.
                for (var y = 100; y < 300; y++)
                    for (var x = 10 + n * 6; x < 190 + n * 6; x++)
                    {
                        var i = (y * Width + x) * 4;
                        frame[i] = (byte)(n * 7);
                        frame[i + 1] = 210;
                        frame[i + 2] = (byte)(255 - n * 6);
                    }

                if (n == ForcedKeyframeAt)
                {
                    encoder.ForceKeyFrame();
                    sinceForce = 0;
                }

                var watch = Stopwatch.StartNew();
                var data = encoder.Encode(Width, Height, frame);
                watch.Stop();
                totalMs += watch.Elapsed.TotalMilliseconds;
                if (Environment.GetEnvironmentVariable("H264TRACE") == "1") Console.WriteLine($"picture {n}: {watch.Elapsed.TotalMilliseconds:0.0} ms {(data is null ? "none" : data.Length + " bytes")}");
                if (sinceForce >= 0) sinceForce++;

                if (data is null) continue;
                outputs++;

                var nals = preparer.Prepare(data, out var keyframe);
                if (nals is null && !firstChecked) return "the first picture was not a keyframe with parameter sets";
                if (nals is null) continue;

                if (!firstChecked)
                {
                    if (!keyframe) return "the first picture was not a keyframe";
                    var sps = nals.FirstOrDefault(x => (x[0] & 0x1F) == H264Packetizer.NalSps);
                    if (sps is null || !H264SpsInfo.TryParse(sps, out var info)) return "the stream's parameter set could not be read";
                    if (info.Width != Width || info.Height != Height) return $"the encoder made {info.Width}x{info.Height}, not {Width}x{Height}";
                    firstChecked = true;
                }
                else if (sinceForce > 0 && keyframe)
                {
                    forcedSeen = true;
                }

                foreach (var nal in nals)
                {
                    var type = nal[0] & 0x1F;
                    if (type is not (1 or 5 or 6 or 7 or 8 or 12)) return $"the output holds an unexpected unit of type {type}";
                }
            }

            if (!firstChecked) return "no picture came out";
            if (outputs < Frames * 2 / 3) return $"only {outputs} of {Frames} pictures came out";
            if (!forcedSeen) return "asking for a keyframe did not produce one";
            var average = totalMs / Frames;
            if (average > MaxAverageMs) return $"too slow: {average:0} ms a picture at {Width}x{Height}";

            // The rate can be changed while running, as the console does when the network changes.
            encoder.SetTargetKbps(800);
            for (var n = 0; n < 4; n++) encoder.Encode(Width, Height, frame);
            return null;
        }
        catch (Exception ex)
        {
            return $"{ex.Message} (picture {picture})";
        }
    }

    /// <summary>The child process's side: runs the check and prints one line of result.</summary>
    public static int RunChild()
    {
        var capability = RunHere();
        Console.WriteLine(Marker + JsonSerializer.Serialize(capability));
        return capability.Available ? 0 : 1;
    }

    /// <summary>Runs the check in a child process with a time limit. Whatever goes wrong means "not available".</summary>
    public static async Task<H264Capability> RunInChildAsync(string? exePath, TimeSpan limit)
    {
        if (string.IsNullOrWhiteSpace(exePath) || !File.Exists(exePath)) return H264Capability.None with { Detail = "the agent program was not found" };

        try
        {
            var start = new ProcessStartInfo(exePath, Argument)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            using var process = Process.Start(start);
            if (process is null) return H264Capability.None with { Detail = "the check could not be started" };

            var output = process.StandardOutput.ReadToEndAsync();
            using var cts = new CancellationTokenSource(limit);
            try
            {
                await process.WaitForExitAsync(cts.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                try { process.Kill(entireProcessTree: true); } catch { }
                return H264Capability.None with { Detail = $"the start-up check took longer than {limit.TotalSeconds:0} seconds" };
            }

            var text = await output.ConfigureAwait(false);
            var line = text.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.StartsWith(Marker, StringComparison.Ordinal));
            if (line is null) return H264Capability.None with { Detail = $"the start-up check ended with code {process.ExitCode} and no result" };

            var parsed = JsonSerializer.Deserialize<H264Capability>(line[Marker.Length..]);
            return parsed ?? H264Capability.None;
        }
        catch (Exception ex)
        {
            return H264Capability.None with { Detail = "the start-up check failed: " + ex.Message };
        }
    }
}
