// agents/windows/AdgRmm.CaptureHelper/IndicatorWindow.cs

using System;

/// <summary>
/// Tells the person who is connected. It is the header of the one panel on their screen, which also holds the
/// End session button, so there is a single window that stays open for as long as the session lasts.
/// </summary>
internal sealed class IndicatorWindow
{
    private readonly SidePanel _panel;

    public IndicatorWindow(SidePanel panel) => _panel = panel;

    /// <summary>Says who is connected, and slides the panel out for a few seconds so the person sees it.</summary>
    public void Show(string text) => _panel.BeginSession(text);

    /// <summary>The panel is never closed while a session lasts, only slid out of the way by the person, so this does nothing.</summary>
    public void Hide() { }
}
