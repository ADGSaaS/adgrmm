// agents/windows/RemoteIQ.CaptureHelper/PromptHost.cs

using System;

/// <summary>
/// Shows the notice and the permission question on the person's screen, and passes their answer back to the
/// agent. Like the panel, it lives only in the helper that belongs to the signed-in user: nothing a person
/// can click ever runs as SYSTEM.
/// </summary>
internal sealed class PromptHost
{
    private readonly UiThread _ui;
    private readonly SidePanel _panel;
    private readonly Action<string> _answer;

    /// <param name="answer">Sends "allow", "deny" or "timeout" to the agent.</param>
    public PromptHost(UiThread ui, SidePanel panel, Action<string> answer)
    {
        _ui = ui;
        _panel = panel;
        _answer = answer;
    }

    /// <summary>
    /// The notice is the panel sliding out. It already says who is connected, so a separate message would only
    /// repeat it with a second window.
    /// </summary>
    public void ShowNotice(string title, string message, int seconds) => _panel.Announce();

    /// <summary>Asks whether to let the technician in. Not answering in time counts as no.</summary>
    public void AskConsent(string technician, int seconds)
        => new ConsentCard(_ui, technician, Math.Clamp(seconds, 5, 120), choice =>
            _answer(choice switch { ConsentChoice.Allow => "allow", ConsentChoice.Deny => "deny", _ => "timeout" }))
            .Show(GlassCard.Placement.TopCenter);
}
