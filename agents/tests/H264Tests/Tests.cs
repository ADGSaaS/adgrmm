using RemoteIQ.Agent.Services;

static class Tests
{
    static int failed, passed;
    static void Check(bool ok, string name) { if (ok) passed++; else { failed++; Console.WriteLine("FAIL: " + name); } }

    // The parts of RFC 6184 a receiver relies on, written independently of the packetizer.
    static byte[] Depacketize(IEnumerable<byte[]> payloads)
    {
        var o = new List<byte>();
        foreach (var p in payloads)
        {
            var t = p[0] & 0x1F;
            if (t == 28)
            {
                if ((p[1] & 0x80) != 0) { o.AddRange(new byte[] { 0, 0, 0, 1 }); o.Add((byte)((p[0] & 0xE0) | (p[1] & 0x1F))); }
                o.AddRange(p.Skip(2));
            }
            else if (t == 24)
            {
                int i = 1;
                while (i + 2 <= p.Length) { int n = (p[i] << 8) | p[i + 1]; i += 2; o.AddRange(new byte[] { 0, 0, 0, 1 }); o.AddRange(p.Skip(i).Take(n)); i += n; }
            }
            else { o.AddRange(new byte[] { 0, 0, 0, 1 }); o.AddRange(p); }
        }
        return o.ToArray();
    }

    static byte[] Nal(byte header, int len, byte fill) { var b = new byte[len]; Array.Fill(b, fill); b[0] = header; return b; }

    static byte[] Au(params byte[][] nals)
    {
        var l = new List<byte>();
        foreach (var n in nals) { l.AddRange(new byte[] { 0, 0, 0, 1 }); l.AddRange(n); }
        return l.ToArray();
    }

    public static int Run()
    {
        // RFC 6184 FU-A: indicator keeps F/NRI and type 28, header carries S/E and the original type.
        var idr = Nal(0x65, 3000, 0x11);
        var fu = H264Packetizer.Packetize(new[] { idr }, 1100);
        Check(fu.Count == 3, "FU-A count");
        Check(fu[0][0] == 0x7C && fu[0][1] == 0x85, "FU-A start header 7C 85");
        Check(fu[1][0] == 0x7C && fu[1][1] == 0x05, "FU-A middle header 7C 05");
        Check(fu[2][0] == 0x7C && fu[2][1] == 0x45, "FU-A end header 7C 45");
        Check(fu.All(p => p.Length <= 1100), "FU-A within payload limit");
        Check(Depacketize(fu).AsSpan(4).SequenceEqual(idr), "FU-A round trip");

        var small = Nal(0x41, 500, 7);
        var single = H264Packetizer.Packetize(new[] { small }, 1100);
        Check(single.Count == 1 && single[0].SequenceEqual(small), "single NAL unchanged");
        Check(H264Packetizer.Packetize(new[] { Nal(0x41, 1100, 7) }, 1100).Count == 1, "NAL of exactly max size is a single packet");
        Check(H264Packetizer.Packetize(new[] { Nal(0x41, 1101, 7) }, 1100).Count == 2, "NAL one byte over fragments");

        var sps = new byte[] { 0x67, 0x42, 0xC0, 0x1F, 0xAB, 0xCD };
        var pps = new byte[] { 0x68, 0xCE, 0x3C, 0x80 };
        var au = new List<byte>();
        au.AddRange(new byte[] { 0, 0, 0, 1, 0x09, 0xF0 });
        au.AddRange(new byte[] { 0, 0, 0, 1 }); au.AddRange(sps);
        au.AddRange(new byte[] { 0, 0, 1 }); au.AddRange(pps);
        au.AddRange(new byte[] { 0, 0, 0, 1 }); au.AddRange(idr);
        var prep = new H264Packetizer.Preparer();
        var nals = prep.Prepare(au.ToArray(), out var key);
        Check(key && nals is { Count: 3 }, "keyframe has SPS PPS IDR, delimiter dropped");
        Check(nals![0].SequenceEqual(sps) && nals[1].SequenceEqual(pps) && nals[2].SequenceEqual(idr), "NAL order and content kept");
        var back = Depacketize(H264Packetizer.Packetize(nals, 1100));
        var again = H264Packetizer.Split(back).Select(n => back.AsSpan(n.Offset, n.Length).ToArray()).ToList();
        Check(again.Count == 3 && again[2].SequenceEqual(idr), "depacketized access unit matches");

        var bare = Au(idr);
        var withMemory = prep.Prepare(bare, out var k2);
        Check(k2 && withMemory is { Count: 3 } && withMemory[0].SequenceEqual(sps), "SPS/PPS added to a keyframe lacking them");
        var fresh = new H264Packetizer.Preparer();
        Check(fresh.Prepare(bare, out var k3) is null && !k3, "keyframe without any parameter sets is unusable");
        var pf = fresh.Prepare(Au(Nal(0x41, 50, 3)), out var k4);
        Check(pf is { Count: 1 } && !k4, "P frame passes without parameter sets");
        Check(H264Packetizer.LooksLikeDecodableKeyframe(au.ToArray()) && !H264Packetizer.LooksLikeDecodableKeyframe(bare), "keyframe check");

        // Filler data (padding a constant-bitrate encoder adds to reach its rate) is not worth sending.
        var padded = new H264Packetizer.Preparer();
        var paddedNals = padded.Prepare(Au(sps, pps, idr, Nal(0x0C, 4000, 0xFF)), out _);
        Check(paddedNals is { Count: 3 } && paddedNals.All(n => (n[0] & 0x1F) != 12), "filler NAL units are dropped");

        var realSps = Convert.FromHexString("6742C01F95A014016EC044000003000400000300F03682211A80");
        Check(H264SpsInfo.TryParse(realSps, out var info) && info.Width == 1280 && info.Height == 720, "SPS parse 1280x720");

        Check(ConsoleVideoPolicy.Parse(null) == ConsoleVideoCodecSetting.Auto && ConsoleVideoPolicy.Parse("garbage") == ConsoleVideoCodecSetting.Auto, "unknown setting is Auto");
        Check(ConsoleVideoPolicy.Parse("VP8") == ConsoleVideoCodecSetting.Vp8 && ConsoleVideoPolicy.Parse("h264") == ConsoleVideoCodecSetting.H264, "parse vp8/h264");
        Check(ConsoleVideoPolicy.Effective(ConsoleVideoCodecSetting.H264, "vp8") == ConsoleVideoCodecSetting.Vp8, "device override can force VP8");
        Check(ConsoleVideoPolicy.Effective(ConsoleVideoCodecSetting.Vp8, "h264") == ConsoleVideoCodecSetting.Vp8, "device override cannot force H264");

        var offer = string.Join("\r\n", "v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 102 106 45",
            "a=rtpmap:96 VP8/90000", "a=rtpmap:97 rtx/90000", "a=fmtp:97 apt=96", "a=rtpmap:98 VP9/90000",
            "a=rtpmap:102 H264/90000", "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
            "a=rtpmap:106 H264/90000", "a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
            "a=rtpmap:45 AV1/90000", "a=mid:0", "");
        var ov = ConsoleCodecNegotiation.ParseOffer(offer);
        Check(ov.Vp8PayloadType == 96 && ov.H264.Count == 2, "offer parsed");
        Check(ConsoleCodecNegotiation.PickH264(ov)?.PayloadType == 106, "constrained baseline preferred");
        var hw = new H264Capability(true, true, "hw", 0, "");
        var sw = new H264Capability(true, false, "sw", 3, "");
        var A = ConsoleVideoCodecSetting.Auto; var H = ConsoleVideoCodecSetting.H264; var V = ConsoleVideoCodecSetting.Vp8;
        Check(ConsoleCodecNegotiation.Decide(A, hw, ov).Codec == ConsoleVideoCodec.H264, "Auto + hardware = H264");
        Check(ConsoleCodecNegotiation.Decide(A, sw, ov).Codec == ConsoleVideoCodec.Vp8, "Auto + software only = VP8");
        Check(ConsoleCodecNegotiation.Decide(A, null, ov).Codec == ConsoleVideoCodec.Vp8, "Auto + check unfinished = VP8");
        Check(ConsoleCodecNegotiation.Decide(A, H264Capability.None, ov).Codec == ConsoleVideoCodec.Vp8, "Auto + failed check = VP8");
        Check(ConsoleCodecNegotiation.Decide(H, sw, ov).Codec == ConsoleVideoCodec.H264, "H264 + software = H264");
        Check(ConsoleCodecNegotiation.Decide(H, H264Capability.None, ov).Codec == ConsoleVideoCodec.Vp8, "H264 setting without a passed self-test is still VP8");
        Check(ConsoleCodecNegotiation.Decide(H, null, ov).Codec == ConsoleVideoCodec.Vp8, "H264 setting before the self-test finished is VP8");
        Check(ConsoleCodecNegotiation.Decide(V, hw, ov).Codec == ConsoleVideoCodec.Vp8, "VP8 setting wins over hardware");
        var noH264 = ConsoleCodecNegotiation.ParseOffer("m=video 9 X 96\r\na=rtpmap:96 VP8/90000\r\n");
        Check(ConsoleCodecNegotiation.Decide(H, hw, noH264).Codec == ConsoleVideoCodec.Vp8, "browser without H264 = VP8");
        var mode0 = ConsoleCodecNegotiation.ParseOffer("m=video 9 X 96 102\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:102 H264/90000\r\na=fmtp:102 packetization-mode=0;profile-level-id=42e01f\r\n");
        Check(ConsoleCodecNegotiation.Decide(H, hw, mode0).Codec == ConsoleVideoCodec.Vp8, "packetization-mode 0 only = VP8");

        var answer = string.Join("\r\n", "v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96 98", "c=IN IP4 0.0.0.0", "a=mid:0", "a=sendonly",
            "a=rtpmap:96 VP8/90000", "a=rtpmap:98 VP9/90000", "a=ssrc:1 cname:x", "");
        var d = ConsoleCodecNegotiation.Decide(A, hw, ov);
        var rewritten = ConsoleCodecNegotiation.ApplyToAnswer(answer, d);
        Check(rewritten.Contains("m=video 9 UDP/TLS/RTP/SAVPF 106 96\r\n"), "answer lists H264 first then VP8");
        Check(rewritten.Contains("a=rtpmap:106 H264/90000") && rewritten.Contains("a=fmtp:106 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f"), "answer carries H264 under the offer's PT and fmtp");
        Check(!rewritten.Contains("VP9") && rewritten.Contains("a=rtpmap:96 VP8/90000") && rewritten.Contains("a=mid:0") && rewritten.Contains("a=ssrc:1"), "other codecs dropped, rest kept");
        Check(ConsoleCodecNegotiation.ApplyToAnswer(answer, ConsoleCodecNegotiation.Decide(V, hw, ov)) == answer, "a VP8 decision leaves an answer without H264 untouched");
        var withH264 = answer.Replace("a=rtpmap:98 VP9/90000", "a=rtpmap:98 H264/90000");
        Check(!ConsoleCodecNegotiation.ApplyToAnswer(withH264, ConsoleCodecNegotiation.Decide(V, hw, ov)).Contains("H264"), "a VP8 decision strips H264 from an answer");

        var got = new List<(byte[] p, int marker, ConsoleVideoCodec c)>();
        using (var sender = new ConsoleVideoSender((p, ts, m, s, c) => { lock (got) got.Add((p, m, c)); }, 20000))
        {
            var vp8 = new byte[2500]; vp8[0] = 0x10;
            sender.Send(3000, vp8);
            Thread.Sleep(300);
            lock (got)
            {
                Check(got.Count == 3 && got[0].p[0] == 0x10 && got[1].p[0] == 0 && got.All(x => x.c == ConsoleVideoCodec.Vp8), "VP8 descriptors as before");
                Check(got[2].marker == 1 && got[0].marker == 0, "VP8 marker on last packet");
                got.Clear();
            }
            sender.SwitchCodec(ConsoleVideoCodec.H264);
            sender.Send(3000, Au(sps, pps, idr));
            Thread.Sleep(400);
            lock (got)
            {
                Check(got.Count == 5 && got.All(x => x.c == ConsoleVideoCodec.H264), "H264 frame sent as 2 single NALs + 3 FU-A");
                Check(got[^1].marker == 1 && got.Take(4).All(x => x.marker == 0), "H264 marker only on last packet");
            }
        }
        var unusable = 0;
        using (var fresh2 = new ConsoleVideoSender((p, ts, m, s, c) => { }, 5000))
        {
            fresh2.SwitchCodec(ConsoleVideoCodec.H264);
            fresh2.OnUnusableFrame += () => unusable++;
            fresh2.Send(3000, bare);
        }
        Check(unusable == 1, "keyframe without parameter sets reports an unusable frame");

        Console.WriteLine($"{passed} passed, {failed} failed");
        return failed == 0 ? 0 : 1;
    }
}
