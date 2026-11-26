// agents/windows/AdgRmm.CaptureHelper/Glass/GlassCards.cs

using System;

/// <summary>The colours and the panel shape every card on the person's screen shares.</summary>
internal static class GlassTheme
{
    public static readonly uint Violet = GlassPainter.Argb(124, 92, 255);
    public static readonly uint Cyan = GlassPainter.Argb(34, 211, 238);
    public static readonly uint Green = GlassPainter.Argb(52, 211, 153);
    public static readonly uint Text = GlassPainter.Argb(243, 245, 250);
    public static readonly uint TextDim = GlassPainter.Argb(167, 176, 196);
    public static readonly uint RedFrom = GlassPainter.Argb(255, 98, 128);
    public static readonly uint RedTo = GlassPainter.Argb(238, 58, 98);

    public const float Radius = 18f;

    /// <summary>A dark glass panel with a soft shadow, a fine edge and a small accent tab on top.</summary>
    public static void Panel(GlassPainter p, float x, float y, float w, float h)
    {
        p.Shadow(x, y, w, h, Radius, 24, 150);
        p.FillRoundGradient(x, y, w, h, Radius, GlassPainter.Argb(214, 32, 36, 54), GlassPainter.Argb(214, 14, 16, 26), true);
        p.StrokeRound(x + 0.5f, y + 0.5f, w - 1, h - 1, Radius, GlassPainter.Argb(64, 255, 255, 255), 1f);
        p.FillRound(x + Radius, y + 1, w - Radius * 2, 1f, 0.5f, GlassPainter.Argb(46, 255, 255, 255));
        p.FillRoundGradient(x + 24, y, 54, 3f, 1.5f, Violet, Cyan, false);
    }

    /// <summary>A pill-shaped button. <paramref name="strong"/> fills it with colour, otherwise it is an outline.</summary>
    public static void Pill(GlassPainter p, float x, float y, float w, float h, string label, bool strong, uint from, uint to, bool hover, bool pressed, bool enabled = true)
    {
        var dy = pressed ? 1f : 0f;
        if (!enabled)
        {
            p.FillRound(x, y + dy, w, h, h / 2, GlassPainter.Argb(40, 255, 255, 255));
            p.Text(label, x, y + dy + (h - 16) / 2 - 1, w, h, 12.5f, true, GlassPainter.Argb(120, 255, 255, 255), 1);
            return;
        }

        if (strong)
        {
            if (hover) p.FillRound(x - 2, y - 2 + dy, w + 4, h + 4, h / 2 + 2, GlassPainter.WithAlpha(from, 70));
            p.FillRoundGradient(x, y + dy, w, h, h / 2, from, to, false);
            p.FillRoundGradient(x, y + dy, w, h, h / 2, GlassPainter.Argb(hover ? 64 : 40, 255, 255, 255), GlassPainter.Argb(0, 255, 255, 255), true);
            p.Text(label, x, y + dy + (h - 16) / 2 - 1, w, h, 12.5f, true, GlassPainter.Argb(255, 255, 255, 255), 1);
        }
        else
        {
            p.FillRound(x, y + dy, w, h, h / 2, GlassPainter.Argb(hover ? 44 : 20, 255, 255, 255));
            p.StrokeRound(x + 0.5f, y + dy + 0.5f, w - 1, h - 1, h / 2, GlassPainter.Argb(hover ? 120 : 76, 255, 255, 255), 1f);
            p.Text(label, x, y + dy + (h - 16) / 2 - 1, w, h, 12.5f, true, Text, 1);
        }
    }

    /// <summary>A thin bar that drains as time runs out.</summary>
    public static void Countdown(GlassPainter p, float x, float y, float w, float remaining)
    {
        p.FillRound(x, y, w, 4f, 2f, GlassPainter.Argb(36, 255, 255, 255));
        var filled = Math.Max(0f, Math.Min(1f, remaining)) * w;
        if (filled > 4f) p.FillRoundGradient(x, y, filled, 4f, 2f, Violet, Cyan, false);
    }
}

internal enum ConsentChoice { Allow, Deny, TimedOut }

/// <summary>
/// Asks the person whether to let a technician in. Not answering counts as no, and the bar shows how long is left.
/// </summary>
internal sealed class ConsentCard : GlassCard
{
    private const int AllowButton = 1;
    private const int DenyButton = 2;
    private const float ContentWidth = 404f;

    private readonly string _message;
    private readonly float _seconds;
    private readonly Action<ConsentChoice> _answered;
    private bool _done;

    public ConsentCard(UiThread ui, string technician, int seconds, Action<ConsentChoice> answered) : base(ui)
    {
        _message = $"{technician} from your IT provider wants to view and control this computer.";
        _seconds = seconds;
        _answered = answered;
    }

    protected override (float W, float H) MeasureSize(GlassPainter measure)
    {
        var message = measure.MeasureHeight(_message, ContentWidth - 48, 13f, false);
        return (ContentWidth + ShadowMargin * 2, 24 + 26 + 8 + message + 18 + 38 + 14 + 14 + 18 + 4 + 20 + ShadowMargin * 2);
    }

    protected override void Paint(GlassPainter p, float width, float height)
    {
        var x = ShadowMargin;
        var y = ShadowMargin;
        var w = width - ShadowMargin * 2;
        var h = height - ShadowMargin * 2;
        GlassTheme.Panel(p, x, y, w, h);

        p.Circle(x + 32, y + 37, 9f, GlassPainter.WithAlpha(GlassTheme.Violet, 70));
        p.Circle(x + 32, y + 37, 5f, GlassTheme.Violet);
        p.Text("Allow remote access?", x + 52, y + 26, w - 72, 26, 17f, true, GlassTheme.Text, 0, false);

        var message = p.MeasureHeight(_message, w - 48 - 20, 13f, false);
        p.Text(_message, x + 52, y + 58, w - 76, message + 4, 13f, false, GlassTheme.TextDim);

        var left = Math.Max(0f, _seconds - Seconds);
        var buttonsY = y + 58 + message + 18;
        GlassTheme.Pill(p, x + w - 20 - 112, buttonsY, 112, 38, "Allow", true, GlassTheme.Violet, GlassTheme.Cyan, Hover == AllowButton, Pressed == AllowButton);
        Button(AllowButton, x + w - 20 - 112, buttonsY, 112, 38);
        GlassTheme.Pill(p, x + w - 20 - 112 - 10 - 96, buttonsY, 96, 38, "Deny", false, 0, 0, Hover == DenyButton, Pressed == DenyButton);
        Button(DenyButton, x + w - 20 - 112 - 10 - 96, buttonsY, 96, 38);

        p.Text($"Auto-refuses in {Math.Ceiling(left)}s", x + 52, buttonsY + 12, 112, 20, 11f, false, GlassTheme.TextDim, 0, false);
        p.Text("Keyboard: Ctrl+Shift+A to allow, Esc to refuse", x + 52, buttonsY + 38 + 10, w - 72, 16, 10.5f, false, GlassTheme.TextDim, 0, false);
        GlassTheme.Countdown(p, x + 20, y + h - 20, w - 40, left / _seconds);

        if (Seconds >= _seconds) Finish(ConsentChoice.TimedOut);
    }

    protected override void OnButton(int id) => Finish(id == AllowButton ? ConsentChoice.Allow : ConsentChoice.Deny);

    // The card never takes the keyboard (it must not steal what the person is typing), so the keys are read as they
    // are pressed anywhere. That makes a stray key in another program a risk, so: Esc refuses, which is the safe
    // direction, while allowing needs the deliberate Ctrl+Shift+A. Keys held down when the card appears, and anything in
    // the first moments, are ignored, so typing that is already under way cannot answer it.
    private const long KeysIgnoredForMs = 400;
    private const int VkEscape = 0x1B, VkControl = 0x11, VkShift = 0x10, VkA = 0x41;
    private bool _escapeWasDown = true, _allowWasDown = true;

    [System.Runtime.InteropServices.DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);

    private static bool Down(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;

    protected override void OnFrame()
    {
        if (_done) return;
        var escape = Down(VkEscape);
        var allow = Down(VkControl) && Down(VkShift) && Down(VkA);
        var settled = Seconds * 1000f >= KeysIgnoredForMs;
        var escapePressed = escape && !_escapeWasDown;
        var allowPressed = allow && !_allowWasDown;
        _escapeWasDown = escape;
        _allowWasDown = allow;
        if (!settled) return;
        if (allowPressed) Finish(ConsentChoice.Allow);
        else if (escapePressed) Finish(ConsentChoice.Deny);
    }

    private void Finish(ConsentChoice choice)
    {
        if (_done) return;
        _done = true;
        Close();
        try { _answered(choice); }
        catch (Exception) { /* the agent has gone */ }
    }
}
