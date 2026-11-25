// RemoteIQ.Agent/Tray/TrayApp.cs
//
// The tray app: a small icon next to the clock for the person using the computer. It runs as that person (the agent service starts it in
// their session with their own token) and asks the agent, over a local pipe, for four things: the computer's status, to ask for help (a
// ticket), and to read and write chat. It runs from the agent's own executable as `RemoteIQ.Agent.exe --tray`, so there is no second program to
// install, update or sign. It closes itself when support turns it off.
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace RemoteIQ.Agent.Tray;

/// <summary>What the server said about this computer, as the tray shows it.</summary>
internal sealed record TrayStatus(
    bool Enabled, bool HelpEnabled, bool ChatEnabled, string? Greeting, string? Phone, string? Email,
    string? DeviceName, string? Customer, string? Site, string? AgentVersion, DateTimeOffset? LastCheckIn, int OpenAlerts,
    IReadOnlyList<TrayStatus.HelpRequest> Requests, int Unread,
    string? Provider = null, string? Hours = null, string? Website = null, string? Contact = null, string? AfterHoursPhone = null, string? Notice = null,
    IReadOnlyList<TrayStatus.TicketItem>? Tickets = null, int UnreadTickets = 0)
{
    public sealed record HelpRequest(int Number, string Status, DateTimeOffset CreatedAt);
    public sealed record TicketItem(int Number, string Subject, string Status, DateTimeOffset UpdatedAt, bool Unread, string? LastSender, string? LastText, string? AutoRepair = null);

    public static TrayStatus? Parse(JsonElement? body)
    {
        if (body is not { ValueKind: JsonValueKind.Object } b) return null;
        string? S(JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        bool B(string name, bool def) => b.TryGetProperty(name, out var v) ? v.ValueKind == JsonValueKind.True : def;
        int I(string name) => b.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var n) ? n : 0;
        var device = b.TryGetProperty("device", out var d) ? d : default;
        var support = b.TryGetProperty("support", out var sp) ? sp : default;
        var reqs = new List<HelpRequest>();
        if (b.TryGetProperty("helpRequests", out var hr) && hr.ValueKind == JsonValueKind.Array)
            foreach (var r in hr.EnumerateArray())
                reqs.Add(new HelpRequest(r.TryGetProperty("number", out var n) && n.TryGetInt32(out var num) ? num : 0, S(r, "status") ?? "", DateTimeOffset.TryParse(S(r, "createdAt"), out var at) ? at : DateTimeOffset.Now));
        var tix = new List<TicketItem>();
        if (b.TryGetProperty("tickets", out var tk) && tk.ValueKind == JsonValueKind.Array)
            foreach (var t in tk.EnumerateArray())
            {
                if (!(t.TryGetProperty("number", out var tn) && tn.TryGetInt32(out var tnum))) continue;
                var lr = t.TryGetProperty("lastReply", out var l) ? l : default;
                tix.Add(new TicketItem(tnum, S(t, "subject") ?? "", S(t, "status") ?? "", DateTimeOffset.TryParse(S(t, "updatedAt"), out var up) ? up : DateTimeOffset.Now,
                    t.TryGetProperty("unread", out var un) && un.ValueKind == JsonValueKind.True, S(lr, "sender"), S(lr, "text"), S(t, "autoRepair")));
            }
        DateTimeOffset? last = DateTimeOffset.TryParse(S(device, "lastCheckInAt"), out var lc) ? lc : null;
        return new TrayStatus(B("enabled", false), B("helpEnabled", true), B("chatEnabled", true), S(b, "greeting"), S(support, "phone"), S(support, "email"),
            S(device, "name"), S(device, "customer"), S(device, "site"), S(device, "agentVersion"), last, I("openAlerts"), reqs, I("unreadMessages"),
            S(support, "provider"), S(support, "hours"), S(support, "website"), S(support, "contact"), S(support, "afterHoursPhone"), S(support, "notice"), tix, I("unreadTickets"));
    }
}

internal static class TrayApp
{
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr handle);

    /// <summary>Who is at the keyboard, as Windows names them. It is shown to support as a label, nothing more.</summary>
    public static string Who => $"{Environment.UserDomainName}\\{Environment.UserName}";

    public static int Run(string? pipe)
    {
        using var mutex = new Mutex(true, @"Local\RemoteIQ.Tray.Instance", out var first);
        if (!first) return 0;   // one tray per person signed in
        ApplicationConfiguration.Initialize();
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        try
        {
            using var ctx = new TrayContext(new TrayClient(pipe));
            Application.Run(ctx);
            return 0;
        }
        catch (Exception e)
        {
            try
            {
                var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "RemoteIQ");
                Directory.CreateDirectory(dir);
                File.AppendAllText(Path.Combine(dir, "tray.log"), $"{DateTimeOffset.Now:u} {e}\n");
            }
            catch { /* nowhere to write: nothing more to do */ }
            return 1;
        }
    }

    /// <summary>The RemoteIQ logo (embedded, 64 px), or the plain "R" badge when it cannot be read.</summary>
    private static Bitmap? Logo()
    {
        try
        {
            using var s = typeof(TrayApp).Assembly.GetManifestResourceStream("RemoteIQ.Agent.tray-logo.png");
            if (s is null) return null;
            using var img = new Bitmap(s);
            return new Bitmap(img);
        }
        catch { return null; }
    }

    public static Icon MakeIcon(bool message)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            using var logo = Logo();
            if (logo is not null) g.DrawImage(logo, new Rectangle(0, 0, 32, 32));
            else
            {
                using var path = new GraphicsPath();
                path.AddArc(0, 0, 10, 10, 180, 90); path.AddArc(21, 0, 10, 10, 270, 90); path.AddArc(21, 21, 10, 10, 0, 90); path.AddArc(0, 21, 10, 10, 90, 90); path.CloseFigure();
                using (var fill = new LinearGradientBrush(new Rectangle(0, 0, 32, 32), Color.FromArgb(0x3b, 0x82, 0xf6), Color.FromArgb(0x1d, 0x4e, 0xd8), 90f)) g.FillPath(fill, path);
                using var font = new Font("Segoe UI", 17f, FontStyle.Bold, GraphicsUnit.Pixel);
                var size = g.MeasureString("R", font);
                g.DrawString("R", font, Brushes.White, (32 - size.Width) / 2f + 1, (32 - size.Height) / 2f);
            }
            if (message)
            {
                g.FillEllipse(Brushes.White, 19, -1, 14, 14);
                g.FillEllipse(Brushes.Crimson, 21, 1, 10, 10);
            }
        }
        var h = bmp.GetHicon();
        try { using var tmp = Icon.FromHandle(h); return (Icon)tmp.Clone(); }
        finally { DestroyIcon(h); }
    }

    /// <summary>Draws each window with made-up data into pictures, so how they look can be checked without a person at a screen.</summary>
    public static int SelfTest(string dir)
    {
        ApplicationConfiguration.Initialize();
        Directory.CreateDirectory(dir);
        var status = new TrayStatus(true, true, true, "Hi, we are here to help.", "555-0100", "help@msp.example", "FRONT-DESK-PC", "Acme Dental", "Head Office", "1.3.39",
            DateTimeOffset.Now.AddMinutes(-2), 1, new[] { new TrayStatus.HelpRequest(1042, "in_progress", DateTimeOffset.Now.AddHours(-3)), new TrayStatus.HelpRequest(1031, "closed", DateTimeOffset.Now.AddDays(-4)) }, 0,
            "Suprs IT Solutions", "Mon to Fri, 8:00 to 17:00 Eastern", "https://www.example.com", "Jordan Lee", "555-0199", "Our phones are down today. Please use chat or email.",
            new[] { new TrayStatus.TicketItem(1042, "Outlook crashes", "in_progress", DateTimeOffset.Now.AddMinutes(-3), true, "Dana", "Please send me the error message you see when Outlook closes."), new TrayStatus.TicketItem(1031, "Printer offline in reception", "open", DateTimeOffset.Now.AddDays(-1), false, null, null, "awaiting_user"), new TrayStatus.TicketItem(1020, "Mouse double-clicks by itself", "pending", DateTimeOffset.Now.AddDays(-2), false, null, null), new TrayStatus.TicketItem(1012, "Need access to the shared drive", "open", DateTimeOffset.Now.AddDays(-3), false, null, null), new TrayStatus.TicketItem(1009, "Monitor flickers", "in_progress", DateTimeOffset.Now.AddDays(-5), false, null, null), new TrayStatus.TicketItem(1003, "Slow login", "open", DateTimeOffset.Now.AddDays(-6), false, null, null) }, 1);
        void Shot(Form f, string name)
        {
            f.StartPosition = FormStartPosition.Manual; f.Location = new Point(-4000, -4000); f.Show();
            Application.DoEvents(); Thread.Sleep(250); Application.DoEvents();
            using var bmp = new Bitmap(f.Width, f.Height);
            f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
            bmp.Save(Path.Combine(dir, name), System.Drawing.Imaging.ImageFormat.Png);
            f.Close();
        }
        Shot(new HomeForm(status, () => { }, () => { }, _ => { }), "status.png");
        {
            // a refresh with news must change the text in place: the same controls, not new ones (that is what flickered)
            var home = new HomeForm(status, () => { }, () => { }, _ => { });
            home.StartPosition = FormStartPosition.Manual; home.Location = new Point(-4000, -4000); home.Show(); Application.DoEvents();
            var before = home.ControlIdentity();
            home.Apply(status with { OpenAlerts = 3, LastCheckIn = DateTimeOffset.Now });
            var more = status.Tickets!.Select((x, i) => i == 0 ? x with { Unread = false } : x).ToList();
            home.Apply(status with { Tickets = more, Unread = 2 });
            home.Apply(status with { Tickets = more, Unread = 2 });
            var after = home.ControlIdentity();
            File.WriteAllText(Path.Combine(dir, "noflicker.txt"), before.SequenceEqual(after) ? "same controls: yes" : "same controls: NO");
            home.Close();
        }
        var tf = new TicketForm(new TrayClient("riq-selftest-none"), status, 1042, "Outlook crashes");
        tf.ShowDemo();
        Shot(tf, "ticket.png");
        var al = new ReplyAlert("Support replied to ticket #1042", "Dana: Please send me the error message you see when Outlook closes.", () => { });
        Shot(al, "alert.png");
        Shot(new HelpForm(new TrayClient("riq-selftest-none"), status, AppCatalog.Demo()), "help.png");
        var sw = new HelpForm(new TrayClient("riq-selftest-none"), status, AppCatalog.Demo());
        sw.ShowSoftwareDemo();
        Shot(sw, "help-software.png");
        File.WriteAllLines(Path.Combine(dir, "catalog.txt"), AppCatalog.Load().Select(x => $"{x.Name} | {x.Publisher} | {x.UsedText}"));
        var chat = new ChatForm(new TrayClient("riq-selftest-none"), status);
        chat.ShowDemo();
        Shot(chat, "chat.png");
        var chat2 = new ChatForm(new TrayClient("riq-selftest-none"), status);
        chat2.ShowDetails();
        Shot(chat2, "chat-details.png");
        var chat3 = new ChatForm(new TrayClient("riq-selftest-none"), status);
        chat3.ShowEnded();
        Shot(chat3, "chat-ended.png");
        using (var ic = MakeIcon(true)) using (var bmp = ic.ToBitmap()) bmp.Save(Path.Combine(dir, "icon-message.png"), System.Drawing.Imaging.ImageFormat.Png);
        using (var ic = MakeIcon(false)) using (var bmp = ic.ToBitmap()) bmp.Save(Path.Combine(dir, "icon.png"), System.Drawing.Imaging.ImageFormat.Png);
        return 0;
    }
}

/* ------------------------------ the icon and its menu ------------------------------ */

internal sealed class TrayContext : ApplicationContext
{
    private readonly TrayClient _client;
    private readonly NotifyIcon _icon = new() { Text = "RemoteIQ support" };
    private readonly Timer _timer = new() { Interval = int.TryParse(Environment.GetEnvironmentVariable("REMOTEIQ_TRAY_POLL_SECONDS"), out var secs) && secs is >= 1 and <= 300 ? secs * 1000 : 15_000 };
    private readonly Icon _normal = TrayApp.MakeIcon(false);
    private readonly Icon _message = TrayApp.MakeIcon(true);
    private TrayStatus? _status;
    private int _offCount;
    private int _lastUnread;
    private bool _shown;
    private Icon? _iconShown;
    private bool _busy;
    private ChatForm? _chat;
    private HelpForm? _help;
    private HomeForm? _home;
    private readonly Dictionary<int, TicketForm> _ticketForms = new();
    private readonly Dictionary<int, DateTimeOffset> _alerted = new();
    private ReplyAlert? _alert;

    public TrayContext(TrayClient client)
    {
        _client = client;
        _icon.Icon = _normal;
        _icon.MouseClick += (_, e) => { if (e.Button == MouseButtons.Left) ShowHome(); };
        _icon.BalloonTipClicked += (_, _) => ShowChat();
        _icon.ContextMenuStrip = new ContextMenuStrip();
        _timer.Tick += async (_, _) => await RefreshAsync();
        _timer.Start();
        _ = RefreshAsync();
    }

    private async Task RefreshAsync()
    {
        if (_busy) return;
        _busy = true;
        try
        {
            var r = await _client.CallAsync(new(TrayProtocol.OpStatus, null, null, false, null));
            var s = r.Ok ? TrayStatus.Parse(r.Body) : null;
            if (s is null)
            {
                // the agent is stopped, updating or the server cannot be reached: keep what is shown, say so in the tooltip
                if (_shown) _icon.Text = "RemoteIQ support (not connected)";
                return;
            }
            if (!s.Enabled)
            {
                // support turned the tray off. One blip is not an answer, so it takes two in a row.
                if (++_offCount >= 2 || !_shown) ExitThread();
                return;
            }
            _offCount = 0;
            _status = s;
            var fresh = s.Unread + s.UnreadTickets;
            var tip = Truncate($"RemoteIQ support{(fresh > 0 ? $" - {fresh} new" : "")}", 63);
            if (_icon.Text != tip) _icon.Text = tip;
            var wanted = fresh > 0 ? _message : _normal;
            if (!ReferenceEquals(_iconShown, wanted)) { _icon.Icon = wanted; _iconShown = wanted; }
            BuildMenu(s);
            if (!_shown) { _icon.Visible = true; _shown = true; }
            // A reply from support is shown in a window that stays until it is dealt with, on top of what the person is doing, with a sound.
            foreach (var t in s.Tickets ?? Array.Empty<TrayStatus.TicketItem>())
            {
                if (!t.Unread) { _alerted.Remove(t.Number); continue; }
                if (_ticketForms.TryGetValue(t.Number, out var open) && !open.IsDisposed && open.Visible) continue;   // they are reading it
                if (_alerted.TryGetValue(t.Number, out var seen) && seen >= t.UpdatedAt) continue;
                _alerted[t.Number] = t.UpdatedAt;
                ShowAlert($"Support replied to ticket #{t.Number}", string.IsNullOrWhiteSpace(t.LastText) ? t.Subject : $"{(string.IsNullOrWhiteSpace(t.LastSender) ? "Support" : t.LastSender)}: {t.LastText}", () => ShowTicket(t.Number));
            }
            if (s.Unread > _lastUnread && !(_chat?.Visible ?? false))
                ShowAlert("Support wrote to you", s.Unread == 1 ? "You have a new chat message." : $"You have {s.Unread} new chat messages.", ShowChat);
            _lastUnread = s.Unread;
            _home?.Apply(s);
        }
        finally { _busy = false; }
    }

    private static string Truncate(string s, int n) => s.Length <= n ? s : s[..n];

    /// <summary>The right-click menu has one item. Everything else is in the window a left click opens, and there is no way to close the agent from here.</summary>
    private void BuildMenu(TrayStatus s)
    {
        var m = _icon.ContextMenuStrip!;
        if (m.Items.Count == 1) return;
        m.Items.Clear();
        m.Items.Add("Restart Agent", null, (_, _) => _ = RestartAgentAsync());
    }

    private async Task RestartAgentAsync()
    {
        var ok = MessageBox.Show("Restart the RemoteIQ agent? Support cannot reach this computer for about half a minute while it restarts.", "Restart Agent",
            MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (ok != DialogResult.Yes) return;
        var r = await _client.CallAsync(new(TrayProtocol.OpRestart, null, null, false, null));
        _icon.ShowBalloonTip(5000, "RemoteIQ agent", r.Ok ? "Restarting. It will be back in a moment." : (r.Error ?? "It could not be restarted."), r.Ok ? ToolTipIcon.Info : ToolTipIcon.Warning);
    }

    private void ShowHelp()
    {
        if (_status is null) return;
        if (_help is { IsDisposed: false }) { _help.Activate(); return; }
        _help = new HelpForm(_client, _status);
        _help.FormClosed += (_, _) => _ = RefreshAsync();
        _help.Show();
    }

    private void ShowChat()
    {
        if (_status is null) return;
        if (_chat is { IsDisposed: false }) { _chat.Show(); _chat.Activate(); return; }
        _chat = new ChatForm(_client, _status);
        _chat.FormClosed += (_, _) => { _lastUnread = 0; _ = RefreshAsync(); };
        _chat.Show();
    }

    private void ShowAlert(string title, string text, Action open)
    {
        try { _alert?.Close(); _alert?.Dispose(); } catch { /* already gone */ }
        _alert = new ReplyAlert(title, text, open);
        _alert.ShowAlert();
    }

    private void ShowTicket(int number)
    {
        if (_status is null) return;
        if (_ticketForms.TryGetValue(number, out var f) && !f.IsDisposed) { f.Show(); f.Activate(); return; }
        var subject = (_status.Tickets ?? Array.Empty<TrayStatus.TicketItem>()).FirstOrDefault(t => t.Number == number)?.Subject ?? "";
        f = new TicketForm(_client, _status, number, subject);
        f.FormClosed += (_, _) => { _ticketForms.Remove(number); _ = RefreshAsync(); };
        _ticketForms[number] = f;
        f.Show();
        f.Activate();
    }

    private void ShowHome()
    {
        if (_status is null) return;
        if (_home is { IsDisposed: false }) { _home.Apply(_status); _home.Show(); _home.Activate(); return; }
        _home = new HomeForm(_status, ShowHelp, ShowChat, ShowTicket);
        _home.Show();
        _home.Activate();
    }

    protected override void ExitThreadCore()
    {
        _timer.Stop();
        _icon.Visible = false;
        _icon.Dispose();
        base.ExitThreadCore();
    }
}
