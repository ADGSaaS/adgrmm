// agents/windows/RemoteIQ.CaptureHelper/Glass/Chime.cs

using System;
using System.IO;
using System.Runtime.InteropServices;

/// <summary>
/// The two short sounds for the chat: a soft two-note chime when a message arrives, and a quieter single tick when
/// the person sends one. They are made from a few sine waves when first needed, so there are no sound files to ship
/// and they sound the same on every machine. A device with no sound hardware simply stays silent.
/// </summary>
internal static class Chime
{
    private const int SampleRate = 44100;
    private const uint SND_ASYNC = 0x0001, SND_NODEFAULT = 0x0002, SND_MEMORY = 0x0004;

    private static readonly object Gate = new();
    private static IntPtr _incoming, _sent;

    /// <summary>A message arrived from the other side.</summary>
    public static void PlayIncoming()
    {
        // E5 then A5, a gentle rising pair.
        Play(ref _incoming, () => Build(new[] { (659.25, 0.11), (880.00, 0.20) }, 0.34));
    }

    /// <summary>The person sent a message.</summary>
    public static void PlaySent()
    {
        // One short, lower, quieter note.
        Play(ref _sent, () => Build(new[] { (523.25, 0.10) }, 0.20));
    }

    private static void Play(ref IntPtr cache, Func<byte[]> build)
    {
        try
        {
            lock (Gate)
            {
                if (cache == IntPtr.Zero)
                {
                    // The sound plays after this call returns, so its bytes must stay put for good.
                    var wav = build();
                    var pin = GCHandle.Alloc(wav, GCHandleType.Pinned);
                    cache = pin.AddrOfPinnedObject();
                }
                PlaySoundW(cache, IntPtr.Zero, SND_MEMORY | SND_ASYNC | SND_NODEFAULT);
            }
        }
        catch (Exception)
        {
            // No sound is not worth failing a chat over.
        }
    }

    /// <summary>One bell-like note after another, each starting softly and fading out.</summary>
    private static byte[] Build(( double Hz, double Seconds)[] notes, double volume)
    {
        var samples = 0;
        foreach (var n in notes) samples += (int)(n.Seconds * SampleRate);

        var pcm = new short[samples + SampleRate / 20];
        var at = 0;
        foreach (var (hz, seconds) in notes)
        {
            var length = (int)(seconds * SampleRate);
            for (var i = 0; i < length; i++)
            {
                var t = i / (double)SampleRate;
                var attack = Math.Min(1.0, t / 0.006);
                var decay = Math.Exp(-t / (seconds * 0.42));
                var wave = Math.Sin(2 * Math.PI * hz * t) + 0.28 * Math.Sin(2 * Math.PI * hz * 2 * t) + 0.08 * Math.Sin(2 * Math.PI * hz * 3 * t);
                pcm[at + i] += (short)(wave / 1.36 * attack * decay * volume * short.MaxValue);
            }
            at += length;
        }

        using var stream = new MemoryStream();
        using var writer = new BinaryWriter(stream);
        var dataBytes = pcm.Length * 2;
        writer.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
        writer.Write(36 + dataBytes);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("WAVEfmt "));
        writer.Write(16);
        writer.Write((short)1);              // plain PCM
        writer.Write((short)1);              // one channel
        writer.Write(SampleRate);
        writer.Write(SampleRate * 2);
        writer.Write((short)2);
        writer.Write((short)16);
        writer.Write(System.Text.Encoding.ASCII.GetBytes("data"));
        writer.Write(dataBytes);
        foreach (var s in pcm) writer.Write(s);
        writer.Flush();
        return stream.ToArray();
    }

    [DllImport("winmm.dll", CharSet = CharSet.Unicode)]
    private static extern bool PlaySoundW(IntPtr sound, IntPtr module, uint flags);
}
