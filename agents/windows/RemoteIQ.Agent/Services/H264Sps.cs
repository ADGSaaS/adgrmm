// agents/windows/RemoteIQ.Agent/Services/H264Sps.cs

namespace RemoteIQ.Agent.Services;

/// <summary>What an H.264 sequence parameter set says about the stream. Read by the start-up check, to be sure an encoder made the picture size that was asked for.</summary>
public readonly record struct H264SpsInfo(int ProfileIdc, int ConstraintFlags, int LevelIdc, int Width, int Height)
{
    /// <summary>The profile-level-id of an SDP fmtp line, such as 42e01f.</summary>
    public string ProfileLevelId => $"{ProfileIdc:x2}{ConstraintFlags:x2}{LevelIdc:x2}";

    /// <param name="nal">The SPS NAL unit, starting with its header byte.</param>
    public static bool TryParse(ReadOnlySpan<byte> nal, out H264SpsInfo info)
    {
        info = default;
        if (nal.Length < 5 || (nal[0] & 0x1F) != H264Packetizer.NalSps) return false;

        // Emulation prevention bytes (00 00 03) are removed first, because the fields are read as plain bits.
        var rbsp = new List<byte>(nal.Length);
        for (var i = 1; i < nal.Length; i++)
        {
            if (i >= 3 && nal[i] == 3 && nal[i - 1] == 0 && nal[i - 2] == 0) continue;
            rbsp.Add(nal[i]);
        }

        var reader = new BitReader(rbsp.ToArray());
        try
        {
            var profile = (int)reader.Bits(8);
            var constraints = (int)reader.Bits(8);
            var level = (int)reader.Bits(8);
            reader.Ue(); // seq_parameter_set_id

            var chromaFormat = 1;
            if (profile is 100 or 110 or 122 or 244 or 44 or 83 or 86 or 118 or 128 or 138 or 139 or 134 or 135)
            {
                chromaFormat = (int)reader.Ue();
                if (chromaFormat == 3) reader.Bits(1);
                reader.Ue(); // bit depth luma
                reader.Ue(); // bit depth chroma
                reader.Bits(1); // transform bypass
                if (reader.Bits(1) == 1) // scaling matrix present
                {
                    var lists = chromaFormat != 3 ? 8 : 12;
                    for (var i = 0; i < lists; i++)
                    {
                        if (reader.Bits(1) == 0) continue;
                        var size = i < 6 ? 16 : 64;
                        long last = 8, next = 8;
                        for (var j = 0; j < size; j++)
                        {
                            if (next != 0)
                            {
                                next = (last + reader.Se() + 256) % 256;
                            }
                            last = next == 0 ? last : next;
                        }
                    }
                }
            }

            reader.Ue(); // log2_max_frame_num - 4
            var pocType = reader.Ue();
            if (pocType == 0) reader.Ue();
            else if (pocType == 1)
            {
                reader.Bits(1);
                reader.Se();
                reader.Se();
                var cycle = reader.Ue();
                for (var i = 0; i < cycle; i++) reader.Se();
            }

            reader.Ue(); // max reference frames
            reader.Bits(1); // gaps in frame num
            var widthMbs = (int)reader.Ue() + 1;
            var heightMapUnits = (int)reader.Ue() + 1;
            var frameMbsOnly = (int)reader.Bits(1);
            if (frameMbsOnly == 0) reader.Bits(1);
            reader.Bits(1); // direct 8x8 inference

            int cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
            if (reader.Bits(1) == 1)
            {
                cropLeft = (int)reader.Ue();
                cropRight = (int)reader.Ue();
                cropTop = (int)reader.Ue();
                cropBottom = (int)reader.Ue();
            }

            var subWidth = chromaFormat is 1 or 2 ? 2 : 1;
            var subHeight = chromaFormat == 1 ? 2 : 1;
            var cropUnitX = chromaFormat == 0 ? 1 : subWidth;
            var cropUnitY = (chromaFormat == 0 ? 1 : subHeight) * (2 - frameMbsOnly);

            var width = widthMbs * 16 - (cropLeft + cropRight) * cropUnitX;
            var height = (2 - frameMbsOnly) * heightMapUnits * 16 - (cropTop + cropBottom) * cropUnitY;
            info = new H264SpsInfo(profile, constraints, level, width, height);
            return width > 0 && height > 0;
        }
        catch (IndexOutOfRangeException)
        {
            return false;
        }
    }

    private sealed class BitReader(byte[] data)
    {
        private int _position;

        public uint Bits(int count)
        {
            uint value = 0;
            for (var i = 0; i < count; i++)
            {
                var index = _position >> 3;
                if (index >= data.Length) throw new IndexOutOfRangeException();
                value = (value << 1) | (uint)((data[index] >> (7 - (_position & 7))) & 1);
                _position++;
            }
            return value;
        }

        public uint Ue()
        {
            var zeros = 0;
            while (Bits(1) == 0)
            {
                if (++zeros > 31) throw new IndexOutOfRangeException();
            }
            return zeros == 0 ? 0 : (1u << zeros) - 1 + Bits(zeros);
        }

        public long Se()
        {
            var k = Ue();
            return (k & 1) == 1 ? (k + 1) / 2 : -(long)(k / 2);
        }
    }
}
