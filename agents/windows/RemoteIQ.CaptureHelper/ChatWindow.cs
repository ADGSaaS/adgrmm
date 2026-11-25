// agents/windows/RemoteIQ.CaptureHelper/ChatWindow.cs

using System;

/// <summary>
/// Where messages from the technician arrive. They go into the one panel on the person's screen, which slides out
/// with a chime when a message comes, without taking focus. The panel goes away with the helper when the session ends.
/// </summary>
internal sealed class ChatWindow
{
    private const int MaxMessageChars = 2000;

    private readonly SidePanel _panel;

    public ChatWindow(SidePanel panel) => _panel = panel;

    /// <summary>Shows a message from the technician.</summary>
    public void ShowMessage(string text)
    {
        if (text.Length > MaxMessageChars) text = text[..MaxMessageChars];
        _panel.Incoming(text);
    }
}
