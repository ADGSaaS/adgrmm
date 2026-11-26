// agents/windows/AdgRmm.CaptureHelper/Glass/GlassPainter.cs

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

/// <summary>
/// Smooth drawing for the windows shown on the person's screen: anti-aliased rounded shapes, gradients, soft
/// shadows and text, on top of the GDI+ that ships with Windows. Nothing here needs a UI framework, which keeps
/// the helper small and quick to start. Everything is measured in logical pixels and scaled to the display.
/// </summary>
internal sealed class GlassPainter : IDisposable
{
    private readonly IntPtr _graphics;
    private readonly float _scale;
    private readonly List<IntPtr> _paths = new();

    public GlassPainter(IntPtr graphics, float scale)
    {
        _graphics = graphics;
        _scale = scale;
        GdipSetSmoothingMode(_graphics, 4);        // anti-aliased
        GdipSetTextRenderingHint(_graphics, 4);    // smooth text that also works on a transparent surface
        GdipSetInterpolationMode(_graphics, 7);    // high quality
        GdipSetPixelOffsetMode(_graphics, 2);      // half-pixel accuracy
    }

    public static uint Argb(int a, int r, int g, int b) => (uint)((a << 24) | (r << 16) | (g << 8) | b);
    public static uint Argb(int r, int g, int b) => Argb(255, r, g, b);
    public static uint WithAlpha(uint color, int alpha) => (color & 0x00FFFFFFu) | ((uint)alpha << 24);

    public void Clear() => GdipGraphicsClear(_graphics, 0);

    // ---- shapes ----

    public void FillRound(float x, float y, float w, float h, float r, uint color)
    {
        using var brush = new Brush(color);
        var path = RoundPath(x, y, w, h, r);
        GdipFillPath(_graphics, brush.Handle, path);
        GdipDeletePath(path);
    }

    /// <summary>A rounded shape that fades from one colour to another, across or down.</summary>
    public void FillRoundGradient(float x, float y, float w, float h, float r, uint from, uint to, bool vertical)
    {
        var p1 = new PointI((int)(x * _scale), (int)(y * _scale));
        var p2 = vertical ? new PointI((int)(x * _scale), (int)((y + h) * _scale)) : new PointI((int)((x + w) * _scale), (int)(y * _scale));
        GdipCreateLineBrushI(ref p1, ref p2, from, to, 0, out var brush);
        var path = RoundPath(x, y, w, h, r);
        GdipFillPath(_graphics, brush, path);
        GdipDeletePath(path);
        GdipDeleteBrush(brush);
    }

    public void StrokeRound(float x, float y, float w, float h, float r, uint color, float width = 1f)
    {
        GdipCreatePen1(color, width * _scale, 2, out var pen);
        var path = RoundPath(x, y, w, h, r);
        GdipDrawPath(_graphics, pen, path);
        GdipDeletePath(path);
        GdipDeletePen(pen);
    }

    public void Circle(float cx, float cy, float radius, uint color)
    {
        using var brush = new Brush(color);
        GdipFillEllipse(_graphics, brush.Handle, (cx - radius) * _scale, (cy - radius) * _scale, radius * 2 * _scale, radius * 2 * _scale);
    }

    /// <summary>A soft shadow: layers of the same shape growing and fading, which looks like a blur without needing one.</summary>
    public void Shadow(float x, float y, float w, float h, float r, int spread, int strength)
    {
        for (var i = spread; i >= 1; i--)
        {
            var alpha = (int)(strength * Math.Pow(1.0 - (double)i / (spread + 1), 2.2) / spread * 2.2);
            if (alpha <= 0) continue;
            FillRound(x - i, y - i + spread * 0.35f, w + i * 2, h + i * 2, r + i, Argb(Math.Min(alpha, 255), 0, 0, 0));
        }
    }

    // ---- text ----

    public void Text(string text, float x, float y, float w, float h, float size, bool bold, uint color, int align = 0, bool wrap = true)
    {
        var font = FontCache.Get(size * _scale, bold);
        using var brush = new Brush(color);
        GdipCreateStringFormat(wrap ? 0 : 0x1000, 0, out var format);   // 0x1000 = no wrapping
        GdipSetStringFormatAlign(format, align);                        // 0 left, 1 centre, 2 right
        GdipSetStringFormatLineAlign(format, 0);
        GdipSetStringFormatTrimming(format, 3);                         // ellipsis at the word
        var rect = new RectF(x * _scale, y * _scale, w * _scale, h * _scale);
        GdipDrawString(_graphics, text, text.Length, font, ref rect, format, brush.Handle);
        GdipDeleteStringFormat(format);
    }

    /// <summary>How tall some text will be at this width, so cards can size themselves to their message.</summary>
    public float MeasureHeight(string text, float width, float size, bool bold)
    {
        var font = FontCache.Get(size * _scale, bold);
        GdipCreateStringFormat(0, 0, out var format);
        var layout = new RectF(0, 0, width * _scale, 10000f);
        GdipMeasureString(_graphics, text, text.Length, font, ref layout, format, out var bounds, out _, out _);
        GdipDeleteStringFormat(format);
        return bounds.H / _scale;
    }

    /// <summary>The size some text takes at this width, for shaping a bubble around a message.</summary>
    public (float W, float H) MeasureText(string text, float maxWidth, float size, bool bold)
    {
        var font = FontCache.Get(size * _scale, bold);
        GdipCreateStringFormat(0, 0, out var format);
        var layout = new RectF(0, 0, maxWidth * _scale, 10000f);
        GdipMeasureString(_graphics, text, text.Length, font, ref layout, format, out var bounds, out _, out _);
        GdipDeleteStringFormat(format);
        return (bounds.W / _scale, bounds.H / _scale);
    }

    /// <summary>Everything drawn after this stays inside the rectangle, until <see cref="ResetClip"/>.</summary>
    public void ClipTo(float x, float y, float w, float h) => GdipSetClipRect(_graphics, x * _scale, y * _scale, w * _scale, h * _scale, 0);

    public void ResetClip() => GdipResetClip(_graphics);

    // ---- helpers ----

    private IntPtr RoundPath(float x, float y, float w, float h, float r)
    {
        x *= _scale; y *= _scale; w *= _scale; h *= _scale; r = Math.Min(r * _scale, Math.Min(w, h) / 2f);
        var d = r * 2;
        GdipCreatePath(0, out var path);
        GdipAddPathArc(path, x, y, d, d, 180, 90);
        GdipAddPathArc(path, x + w - d, y, d, d, 270, 90);
        GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0, 90);
        GdipAddPathArc(path, x, y + h - d, d, d, 90, 90);
        GdipClosePathFigure(path);
        return path;
    }

    public void Dispose()
    {
        foreach (var path in _paths) GdipDeletePath(path);
        _paths.Clear();
    }

    private sealed class Brush : IDisposable
    {
        public readonly IntPtr Handle;
        public Brush(uint color) => GdipCreateSolidFill(color, out Handle);
        public void Dispose() => GdipDeleteBrush(Handle);
    }

    /// <summary>Fonts are made once. Segoe UI Variable is the newer Windows face, and Segoe UI covers older Windows.</summary>
    private static class FontCache
    {
        private static readonly Dictionary<(int, bool), IntPtr> Fonts = new();
        private static IntPtr _family;

        public static IntPtr Get(float pixels, bool bold)
        {
            var key = ((int)Math.Round(pixels * 10), bold);
            if (Fonts.TryGetValue(key, out var existing)) return existing;

            if (_family == IntPtr.Zero)
            {
                if (GdipCreateFontFamilyFromName("Segoe UI Variable Display", IntPtr.Zero, out _family) != 0 || _family == IntPtr.Zero)
                    GdipCreateFontFamilyFromName("Segoe UI", IntPtr.Zero, out _family);
            }

            GdipCreateFont(_family, pixels, bold ? 1 : 0, 2, out var font);
            Fonts[key] = font;
            return font;
        }
    }

    [StructLayout(LayoutKind.Sequential)] private struct PointI { public int X, Y; public PointI(int x, int y) { X = x; Y = y; } }
    [StructLayout(LayoutKind.Sequential)] private struct RectF { public float X, Y, W, H; public RectF(float x, float y, float w, float h) { X = x; Y = y; W = w; H = h; } }

    private const string Gdi = "gdiplus.dll";
    [DllImport(Gdi)] private static extern int GdipSetClipRect(IntPtr g, float x, float y, float w, float h, int combineMode);
    [DllImport(Gdi)] private static extern int GdipResetClip(IntPtr g);
    [DllImport(Gdi)] private static extern int GdipSetSmoothingMode(IntPtr g, int mode);
    [DllImport(Gdi)] private static extern int GdipSetTextRenderingHint(IntPtr g, int hint);
    [DllImport(Gdi)] private static extern int GdipSetInterpolationMode(IntPtr g, int mode);
    [DllImport(Gdi)] private static extern int GdipSetPixelOffsetMode(IntPtr g, int mode);
    [DllImport(Gdi)] private static extern int GdipGraphicsClear(IntPtr g, uint color);
    [DllImport(Gdi)] private static extern int GdipCreateSolidFill(uint color, out IntPtr brush);
    [DllImport(Gdi)] private static extern int GdipCreateLineBrushI(ref PointI p1, ref PointI p2, uint c1, uint c2, int wrap, out IntPtr brush);
    [DllImport(Gdi)] private static extern int GdipDeleteBrush(IntPtr brush);
    [DllImport(Gdi)] private static extern int GdipCreatePen1(uint color, float width, int unit, out IntPtr pen);
    [DllImport(Gdi)] private static extern int GdipDeletePen(IntPtr pen);
    [DllImport(Gdi)] private static extern int GdipCreatePath(int fillMode, out IntPtr path);
    [DllImport(Gdi)] private static extern int GdipAddPathArc(IntPtr path, float x, float y, float w, float h, float start, float sweep);
    [DllImport(Gdi)] private static extern int GdipClosePathFigure(IntPtr path);
    [DllImport(Gdi)] private static extern int GdipDeletePath(IntPtr path);
    [DllImport(Gdi)] private static extern int GdipFillPath(IntPtr g, IntPtr brush, IntPtr path);
    [DllImport(Gdi)] private static extern int GdipDrawPath(IntPtr g, IntPtr pen, IntPtr path);
    [DllImport(Gdi)] private static extern int GdipFillEllipse(IntPtr g, IntPtr brush, float x, float y, float w, float h);
    [DllImport(Gdi, CharSet = CharSet.Unicode)] private static extern int GdipCreateFontFamilyFromName(string name, IntPtr collection, out IntPtr family);
    [DllImport(Gdi)] private static extern int GdipCreateFont(IntPtr family, float size, int style, int unit, out IntPtr font);
    [DllImport(Gdi)] private static extern int GdipCreateStringFormat(int flags, int language, out IntPtr format);
    [DllImport(Gdi)] private static extern int GdipDeleteStringFormat(IntPtr format);
    [DllImport(Gdi)] private static extern int GdipSetStringFormatAlign(IntPtr format, int align);
    [DllImport(Gdi)] private static extern int GdipSetStringFormatLineAlign(IntPtr format, int align);
    [DllImport(Gdi)] private static extern int GdipSetStringFormatTrimming(IntPtr format, int trimming);
    [DllImport(Gdi, CharSet = CharSet.Unicode)] private static extern int GdipDrawString(IntPtr g, string text, int length, IntPtr font, ref RectF layout, IntPtr format, IntPtr brush);
    [DllImport(Gdi, CharSet = CharSet.Unicode)] private static extern int GdipMeasureString(IntPtr g, string text, int length, IntPtr font, ref RectF layout, IntPtr format, out RectF bounds, out int codepoints, out int lines);
}
