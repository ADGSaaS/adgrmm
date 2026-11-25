// agents/windows/RemoteIQ.Agent/Services/H264Packetizer.cs

namespace RemoteIQ.Agent.Services;

/// <summary>
/// Reads H.264 in Annex B form (what Media Foundation encoders produce: NAL units separated by 00 00 01 or 00 00 00 01),
/// makes sure every keyframe carries its parameter sets, and cuts frames into RTP payloads as RFC 6184 describes for
/// packetization-mode=1 (non-interleaved): a NAL unit that fits goes out as it is, a larger one as FU-A fragments.
/// </summary>
public static class H264Packetizer
{
    public const int NalSlice = 1;
    public const int NalIdr = 5;
    public const int NalSei = 6;
    public const int NalSps = 7;
    public const int NalPps = 8;
    public const int NalAccessUnitDelimiter = 9;
    public const int NalFiller = 12;
    public const int NalStapA = 24;
    public const int NalFuA = 28;

    /// <summary>One NAL unit's place in a buffer, without its start code.</summary>
    public readonly record struct Nal(int Offset, int Length)
    {
        public int Type(ReadOnlySpan<byte> data) => data[Offset] & 0x1F;
    }

    /// <summary>Splits an Annex B buffer. Bytes before the first start code are ignored, and trailing zero bytes belong to the start code of the next unit.</summary>
    public static List<Nal> Split(ReadOnlySpan<byte> data)
    {
        var result = new List<Nal>();
        var start = -1;
        var i = 0;
        while (i + 2 < data.Length)
        {
            if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1)
            {
                if (start >= 0) Add(result, data, start, i);
                start = i + 3;
                i += 3;
                continue;
            }
            i++;
        }
        if (start >= 0) Add(result, data, start, data.Length);
        return result;
    }

    private static void Add(List<Nal> list, ReadOnlySpan<byte> data, int start, int end)
    {
        // The zero that makes a start code four bytes long, and any padding, are not part of the unit.
        while (end > start && data[end - 1] == 0) end--;
        if (end > start) list.Add(new Nal(start, end - start));
    }

    /// <summary>
    /// Takes one encoded picture and returns its NAL units in the order they are sent: delimiters dropped, and a picture
    /// with an IDR slice always starting with SPS and PPS, from the picture itself or else from the last ones seen. A
    /// receiver that joins at a keyframe, or recovers at one, can then decode it without having seen anything before it.
    /// </summary>
    public sealed class Preparer
    {
        private byte[]? _sps;
        private byte[]? _pps;

        public bool HasParameterSets => _sps is not null && _pps is not null;

        /// <summary>Parameter sets known from elsewhere, such as the encoder's output type, used when a keyframe has none of its own.</summary>
        public void SetParameterSets(byte[]? sps, byte[]? pps)
        {
            if (sps is { Length: > 0 }) _sps = sps;
            if (pps is { Length: > 0 }) _pps = pps;
        }

        /// <returns>The NAL units (each without start code), or null when the picture holds nothing that can be sent. <paramref name="keyframe"/> says whether it can be decoded without earlier pictures.</returns>
        public List<byte[]>? Prepare(ReadOnlySpan<byte> annexB, out bool keyframe)
        {
            keyframe = false;
            var nals = Split(annexB);
            if (nals.Count == 0) return null;

            byte[]? sps = null, pps = null;
            var body = new List<byte[]>();
            foreach (var nal in nals)
            {
                var type = nal.Type(annexB);
                var bytes = annexB.Slice(nal.Offset, nal.Length).ToArray();
                switch (type)
                {
                    case NalSps: sps = bytes; break;
                    case NalPps: pps = bytes; break;
                    case NalAccessUnitDelimiter: break;
                    // Padding that a constant-bitrate encoder adds to reach its rate. A decoder ignores it, so it is not worth sending.
                    case NalFiller: break;
                    case NalIdr: keyframe = true; body.Add(bytes); break;
                    default: body.Add(bytes); break;
                }
            }

            if (sps is not null) _sps = sps;
            if (pps is not null) _pps = pps;

            if (body.Count == 0) return null;
            if (!keyframe) return body;

            if (_sps is null || _pps is null)
            {
                // A keyframe nobody could start from is worse than none, so the caller is told it is unusable.
                keyframe = false;
                return null;
            }

            body.Insert(0, _pps);
            body.Insert(0, _sps);
            return body;
        }
    }

    /// <summary>Cuts NAL units into RTP payloads. The last one of the returned list is the last of the picture.</summary>
    public static List<byte[]> Packetize(IReadOnlyList<byte[]> nals, int maxPayload)
    {
        if (maxPayload < 3) throw new ArgumentOutOfRangeException(nameof(maxPayload));

        var payloads = new List<byte[]>();
        foreach (var nal in nals)
        {
            if (nal.Length == 0) continue;

            if (nal.Length <= maxPayload)
            {
                payloads.Add(nal);
                continue;
            }

            // FU-A: the NAL header is not repeated in the data. Its F and NRI bits go in the indicator, and its type in each fragment header.
            var indicator = (byte)((nal[0] & 0xE0) | NalFuA);
            var type = (byte)(nal[0] & 0x1F);
            var room = maxPayload - 2;
            for (var offset = 1; offset < nal.Length; offset += room)
            {
                var size = Math.Min(room, nal.Length - offset);
                var first = offset == 1;
                var last = offset + size >= nal.Length;
                var payload = new byte[size + 2];
                payload[0] = indicator;
                payload[1] = (byte)((first ? 0x80 : 0) | (last ? 0x40 : 0) | type);
                Buffer.BlockCopy(nal, offset, payload, 2, size);
                payloads.Add(payload);
            }
        }
        return payloads;
    }

    /// <summary>
    /// Annex B bytes with an SPS, a PPS and an IDR slice, the smallest thing a decoder accepts as a start. Used by the
    /// start-up check, and by tests that need to tell a real keyframe from a stream that merely looks like one.
    /// </summary>
    public static bool LooksLikeDecodableKeyframe(ReadOnlySpan<byte> annexB)
    {
        bool sps = false, pps = false, idr = false;
        foreach (var nal in Split(annexB))
        {
            switch (nal.Type(annexB))
            {
                case NalSps: sps = nal.Length >= 4; break;
                case NalPps: pps = nal.Length >= 2; break;
                case NalIdr: idr = nal.Length >= 2; break;
            }
        }
        return sps && pps && idr;
    }
}
