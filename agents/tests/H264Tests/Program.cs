using System.Diagnostics;
using RemoteIQ.Agent.Services;

if (args.Length > 0 && args[0] == "probe") return Probe.Run(args);
if (args.Length > 1 && args[0] == "selftest") { var one = MfH264Encoder.Enumerate()[int.Parse(args[1])]; Console.WriteLine(one + ": " + (H264SelfTest.TestOne(one) ?? "passed")); return 0; }
if (args.Length > 0 && args[0] == "selftest") { var c = H264SelfTest.RunHere(Console.WriteLine); Console.WriteLine(c); return c.Available ? 0 : 1; }
return Tests.Run();

static class Probe
{
    public static int Run(string[] args)
    {
        int w = args.Length > 1 ? int.Parse(args[1]) : 1280, h = args.Length > 2 ? int.Parse(args[2]) : 720;
        var cands = MfH264Encoder.Enumerate();
        Console.WriteLine($"{cands.Count} candidates");
        foreach (var c in cands) Console.WriteLine("  " + c);
        foreach (var c in (Environment.GetEnvironmentVariable("H264IDX") is { } ix ? cands.Skip(int.Parse(ix)).Take(1) : cands.Take(Environment.GetEnvironmentVariable("H264ONE") == "1" ? 1 : 99)))
        {
            Console.WriteLine($"--- {c}");
            try
            {
                using var enc = new MfH264Encoder(c, 3000, 30) { Trace = m => Console.WriteLine("  trace: " + m) };
                var frame = new byte[w * h * 4];
                var rnd = new Random(1);
                for (int i = 0; i < frame.Length; i += 4) { frame[i] = (byte)(i / 4 % w / 4); frame[i + 1] = (byte)(i / 4 / w / 4); frame[i + 2] = 128; frame[i + 3] = 255; }
                var times = new List<double>();
                for (int n = 0; n < (args.Length > 3 ? int.Parse(args[3]) : 40); n++)
                {
                    // move a block
                    for (int y = 100; y < 300; y++) for (int x = 10 + (n % 100) * 8; x < 200 + (n % 100) * 8; x++) { int i = (y * w + x) * 4; frame[i] = (byte)(n * 6 + 1); frame[i + 1] = 200; frame[i + 2] = (byte)(255 - n * 5); }
                    if (n == 25) enc.ForceKeyFrame();
                    var t = Stopwatch.GetTimestamp();
                    var o = enc.Encode(w, h, frame);
                    var ms = (Stopwatch.GetTimestamp() - t) * 1000.0 / Stopwatch.Frequency;
                    times.Add(ms);
                    var nals = o is null ? "null" : string.Join(",", H264Packetizer.Split(o).Select(x => x.Type(o)));
                    Console.WriteLine($"frame {n}: {ms:0.0} ms bytes={(o?.Length ?? 0)} nals={nals}"); if (n == 0 && o != null) foreach (var q in H264Packetizer.Split(o)) if (q.Type(o) == 7) { Console.WriteLine("SPS " + Convert.ToHexString(o.AsSpan(q.Offset, q.Length)) + " parsed=" + (H264SpsInfo.TryParse(o.AsSpan(q.Offset, q.Length), out var si) ? si.ToString() : "fail")); }
                }
            }
            catch (Exception ex) { Console.WriteLine("FAILED " + ex); }
        }
        return 0;
    }
}
