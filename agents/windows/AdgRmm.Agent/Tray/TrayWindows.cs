// AdgRmm.Agent/Tray/TrayWindows.cs
//
// The tray's windows (support ticket, chat, status), drawn in the same dark glass style as the chat panel of a remote console session
// (agents/windows/AdgRmm.CaptureHelper/Glass): a navy gradient, a violet-to-cyan accent, pill buttons, a pill input and chat bubbles.
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Timer = System.Windows.Forms.Timer;

namespace AdgRmm.Agent.Tray;

/// <summary>Makes the scroll bars of a control dark, like the rest of the window (Windows' own dark style for them).</summary>
internal static class DarkScroll
{
    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)] private static extern int SetWindowTheme(IntPtr hwnd, string? subAppName, string? subIdList);
    public static void Apply(Control c) { try { if (c.IsHandleCreated) SetWindowTheme(c.Handle, "DarkMode_Explorer", null); } catch { /* an older Windows keeps its light scroll bars */ } }
}

/// <summary>Layout panels that paint off screen, so a change in one of them never shows as a flicker, with dark scroll bars.</summary>
internal sealed class BufferedTable : System.Windows.Forms.TableLayoutPanel { public BufferedTable() { DoubleBuffered = true; } protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DarkScroll.Apply(this); } }
internal sealed class BufferedFlow : System.Windows.Forms.FlowLayoutPanel { public BufferedFlow() { DoubleBuffered = true; } protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DarkScroll.Apply(this); } }

/// <summary>A list with a dark scroll bar.</summary>
internal sealed class DarkListBox : System.Windows.Forms.ListBox { protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); DarkScroll.Apply(this); } }

/// <summary>The colours of the remote console chat panel.</summary>
internal static class Glass
{
    public static readonly Color Violet = Color.FromArgb(124, 92, 255);
    public static readonly Color Cyan = Color.FromArgb(34, 211, 238);
    public static readonly Color Green = Color.FromArgb(52, 211, 153);
    public static readonly Color Text = Color.FromArgb(243, 245, 250);
    public static readonly Color Dim = Color.FromArgb(167, 176, 196);
    public static readonly Color Red = Color.FromArgb(255, 98, 128);
    public static readonly Color Amber = Color.FromArgb(251, 191, 36);
    public static readonly Color InputFill = Color.FromArgb(27, 31, 46);
    public static readonly Color Top = Color.FromArgb(32, 36, 54);
    public static readonly Color Bottom = Color.FromArgb(14, 16, 26);
    public static Color White(int alpha) => Color.FromArgb(alpha, 255, 255, 255);

    public static GraphicsPath Round(RectangleF r, float radius)
    {
        var d = Math.Min(radius * 2, Math.Min(r.Width, r.Height));
        var p = new GraphicsPath();
        if (d <= 0) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90); p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90); p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static void Smooth(Graphics g) { g.SmoothingMode = SmoothingMode.AntiAlias; g.PixelOffsetMode = PixelOffsetMode.HighQuality; }
}

/// <summary>A pill-shaped button: filled with the violet-to-cyan accent, or an outline.</summary>
internal sealed class PillButton : Control
{
    private bool _hover, _down;
    public bool Strong { get; set; }
    public bool Danger { get; set; }

    public PillButton(string text, bool strong = false)
    {
        Text = text; Strong = strong;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        Size = new Size(strong ? 104 : 88, 36); Cursor = Cursors.Hand; TabStop = true;
        Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
    }

    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; _down = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnMouseDown(MouseEventArgs e) { _down = true; Invalidate(); Focus(); base.OnMouseDown(e); }
    protected override void OnMouseUp(MouseEventArgs e) { _down = false; Invalidate(); base.OnMouseUp(e); }
    protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
    protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
    protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    protected override bool IsInputKey(Keys k) => k is Keys.Enter or Keys.Space || base.IsInputKey(k);
    protected override void OnKeyDown(KeyEventArgs e) { if (e.KeyCode is Keys.Space or Keys.Enter) { OnClick(EventArgs.Empty); e.Handled = true; } base.OnKeyDown(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        var r = new RectangleF(0.5f, 0.5f + (_down ? 1 : 0), Width - 2, Height - 2);
        using var path = Glass.Round(r, r.Height / 2);
        Color text;
        if (!Enabled)
        {
            using var b = new SolidBrush(Glass.White(40)); g.FillPath(b, path);
            text = Glass.White(120);
        }
        else if (Strong)
        {
            Color from = Danger ? Glass.Red : Glass.Violet, to = Danger ? Color.FromArgb(238, 58, 98) : Glass.Cyan;
            if (_hover) { using var glow = new SolidBrush(Color.FromArgb(50, from)); using var gp = Glass.Round(RectangleF.Inflate(r, 1.5f, 1.5f), r.Height / 2 + 1.5f); g.FillPath(glow, gp); }
            using var br = new LinearGradientBrush(new RectangleF(0, 0, Width, Height), from, to, 0f); g.FillPath(br, path);
            using var sheen = new LinearGradientBrush(new RectangleF(0, 0, Width, Height), Color.FromArgb(_hover ? 64 : 40, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f); g.FillPath(sheen, path);
            text = Color.White;
        }
        else
        {
            if (_hover) { using var b = new SolidBrush(Glass.White(22)); g.FillPath(b, path); }
            using var pen = new Pen(Glass.White(_hover ? 120 : 70), 1f); g.DrawPath(pen, path);
            text = Glass.Text;
        }
        TextRenderer.DrawText(g, Text, Font, new Rectangle(0, _down ? 1 : 0, Width, Height), text, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine | TextFormatFlags.NoPrefix);
        if (Focused && Enabled) { using var pen = new Pen(Glass.White(150), 1f) { DashStyle = DashStyle.Dot }; using var fp = Glass.Round(RectangleF.Inflate(r, -3, -3), r.Height / 2 - 3); g.DrawPath(pen, fp); }
    }
}

/// <summary>A rounded dark field around a plain text box, like the input of the chat panel.</summary>
internal sealed class PillInput : Control
{
    public TextBox Box { get; }
    private readonly float _radius;

    public PillInput(bool multiline, int maxLength, string placeholder = "")
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.ContainerControl | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        _radius = multiline ? 16 : 21;
        Box = new TextBox
        {
            BorderStyle = BorderStyle.None, BackColor = Glass.InputFill, ForeColor = Glass.Text, Multiline = multiline, MaxLength = maxLength,
            Font = new Font("Segoe UI", 10f), PlaceholderText = placeholder, AcceptsReturn = multiline, ScrollBars = ScrollBars.None, Dock = DockStyle.None,
        };
        Controls.Add(Box);
        Padding = new Padding(multiline ? 14 : 18, multiline ? 11 : 0, multiline ? 14 : 18, multiline ? 11 : 0);
        Box.GotFocus += (_, _) => Invalidate(); Box.LostFocus += (_, _) => Invalidate();
        Click += (_, _) => Box.Focus();
    }

    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        if (Box.Multiline) Box.SetBounds(Padding.Left, Padding.Top, Math.Max(10, Width - Padding.Horizontal), Math.Max(10, Height - Padding.Vertical));
        else { var h = Box.PreferredHeight; Box.SetBounds(Padding.Left, (Height - h) / 2, Math.Max(10, Width - Padding.Horizontal), h); }
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        var r = new RectangleF(0.5f, 0.5f, Width - 2, Height - 2);
        using var path = Glass.Round(r, _radius);
        using (var b = new SolidBrush(Glass.InputFill)) g.FillPath(b, path);
        using var pen = new Pen(Box.Focused ? Color.FromArgb(150, Glass.Violet) : Glass.White(70), 1f); g.DrawPath(pen, path);
    }
}

/// <summary>The window frame: a navy gradient, a fine edge and the violet-to-cyan tab on top, with a dark title bar.</summary>
internal abstract class TrayForm : Form
{
    [DllImport("dwmapi.dll")] private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    protected TrayForm(string title, Size size)
    {
        Text = title;
        Font = new Font("Segoe UI", 9.5f);
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = size;
        MinimumSize = size;
        ShowInTaskbar = true;
        Icon = TrayApp.MakeIcon(false);
        BackColor = Glass.Bottom;
        ForeColor = Glass.Text;
        DoubleBuffered = true;
        Padding = new Padding(20, 24, 20, 18);
        SetStyle(ControlStyles.ResizeRedraw, true);
    }

    /// <summary>WS_EX_COMPOSITED: the window and everything in it is painted as one picture, so partial updates do not flash.</summary>
    protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x02000000; return cp; } }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        try { var on = 1; if (DwmSetWindowAttribute(Handle, 20, ref on, 4) != 0) DwmSetWindowAttribute(Handle, 19, ref on, 4); } catch { /* an older Windows keeps its light title bar */ }
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        using (var br = new LinearGradientBrush(ClientRectangle, Glass.Top, Glass.Bottom, 90f)) g.FillRectangle(br, ClientRectangle);
        using (var pen = new Pen(Glass.White(46), 1f)) g.DrawLine(pen, 0, 0, Width, 0);
        using var tab = new LinearGradientBrush(new Rectangle(26, 0, 54, 3), Glass.Violet, Glass.Cyan, 0f);
        using var tp = Glass.Round(new RectangleF(26, -2, 54, 5), 1.5f);
        g.FillPath(tab, tp);
    }

    /// <summary>A heading with a glowing dot, like "Your IT provider" at the top of the chat panel.</summary>
    protected static string ProviderOf(TrayStatus s) => string.IsNullOrWhiteSpace(s.Provider) ? "Your IT provider" : s.Provider!;

    protected internal sealed class Header : Control
    {
        private readonly Color _dot;
        public Header(string text, Color dot) { Text = text; _dot = dot; Height = 30; Dock = DockStyle.Top; SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.OptimizedDoubleBuffer, true); BackColor = Color.Transparent; Font = new Font("Segoe UI", 11f, FontStyle.Bold); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics; Glass.Smooth(g);
            using (var b = new SolidBrush(Color.FromArgb(60, _dot))) g.FillEllipse(b, 0, 5, 18, 18);
            using (var b = new SolidBrush(_dot)) g.FillEllipse(b, 5, 10, 8, 8);
            TextRenderer.DrawText(g, Text, Font, new Point(26, 3), Glass.Text, TextFormatFlags.NoPadding);
        }
    }

    protected static Label Note(string text, bool muted = true) => new()
    {
        Text = text, AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = muted ? Glass.Dim : Glass.Text, BackColor = Color.Transparent, Margin = new Padding(0, 0, 0, 8),
    };
}

/// <summary>What the person at the computer said about themselves (kept for them, on this computer, in their own profile): name, email and phone.</summary>
internal sealed record TrayDetails(string Name, string Email, string Phone)
{
    private static string PathOf => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AdgRmm", "tray-details.json");

    public static TrayDetails Load()
    {
        try { return JsonSerializer.Deserialize<TrayDetails>(File.ReadAllText(PathOf)) ?? new("", "", ""); }
        catch { return new("", "", ""); }
    }

    public void Save()
    {
        try { Directory.CreateDirectory(Path.GetDirectoryName(PathOf)!); File.WriteAllText(PathOf, JsonSerializer.Serialize(this)); }
        catch { /* nowhere to keep it: they are asked again next time */ }
    }

    public static bool ValidEmail(string s) => System.Text.RegularExpressions.Regex.IsMatch(s.Trim(), @"^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$");
    public static bool ValidPhone(string s) => System.Text.RegularExpressions.Regex.IsMatch(s.Trim(), @"^[0-9+().\-x#* ]+$") && s.Count(char.IsDigit) >= 5;

    /// <summary>What is missing or wrong, in words, or null when it is good. Tickets need all three; chat needs a name and a phone number, and an email only when one is given.</summary>
    public string? Problem(bool needEmail)
    {
        if (string.IsNullOrWhiteSpace(Name)) return "Please enter your name.";
        if (needEmail || !string.IsNullOrWhiteSpace(Email))
            if (!ValidEmail(Email)) return "Please enter a valid email address. Support will answer you there.";
        if (!ValidPhone(Phone)) return "Please enter a phone number support can reach you on.";
        return null;
    }
}

internal sealed class HelpForm : TrayForm
{
    private static readonly string[] Categories = { "Software Issue", "Printing", "Internet or network", "Email", "Slow computer", "Sign-in or password", "Hardware", "Security concern", "Other" };
    private const string NoApp = "Windows itself, or not sure";

    private readonly TrayClient _client;
    private readonly ComboBox _category = new() { DropDownStyle = ComboBoxStyle.DropDownList, FlatStyle = FlatStyle.Flat, DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 26, BackColor = Glass.InputFill, ForeColor = Glass.Text, Font = new Font("Segoe UI", 10f), Dock = DockStyle.Fill, Margin = new Padding(0) };
    private readonly PillInput _app = new(false, 120, "Which program? Click and type to search");
    private readonly DarkListBox _appList = new() { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Glass.InputFill, ForeColor = Glass.Text, DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = 40, IntegralHeight = false, Visible = false };
    private readonly PillInput _name = new(false, 120, "Your name");
    private readonly PillInput _email = new(false, 200, "Your email address (support will answer you here)");
    private readonly PillInput _phone = new(false, 40, "Your phone number");
    private readonly PillInput _subject = new(false, 120, "Subject: a few words about the problem");
    private readonly PillInput _text = new(true, TrayProtocol.MaxMessageChars, "Describe what is wrong");
    private readonly CheckBox _urgent = new() { Text = "This is urgent: I cannot work", AutoSize = true, ForeColor = Glass.Text, BackColor = Color.Transparent, FlatStyle = FlatStyle.Standard };
    private readonly PillButton _send = new("Submit ticket", true) { Width = 132 };
    private readonly Label _result = new() { AutoSize = true, MaximumSize = new Size(430, 0), BackColor = Color.Transparent, Margin = new Padding(0, 6, 0, 0) };
    private readonly Panel _appRow = new() { Dock = DockStyle.Top, Height = 44, Visible = false, BackColor = Color.Transparent };
    private readonly Panel _stack = new() { Dock = DockStyle.Fill, BackColor = Color.Transparent };
    private List<InstalledApp> _all = new();
    private List<InstalledApp> _shown = new();
    private InstalledApp? _chosen;
    private bool _noApp, _softwareOn;

    public HelpForm(TrayClient client, TrayStatus status, List<InstalledApp>? demoApps = null) : base("Submit a support ticket", new Size(480, 740))
    {
        _client = client;
        var saved = TrayDetails.Load();
        _name.Box.Text = saved.Name; _email.Box.Text = saved.Email; _phone.Box.Text = saved.Phone;
        _category.Items.AddRange(Categories);
        _category.DrawItem += (_, e) =>
        {
            if (e.Index < 0) return;
            var sel = (e.State & DrawItemState.Selected) != 0;
            using var back = new SolidBrush(sel ? Color.FromArgb(70, 60, 140) : Glass.InputFill);
            e.Graphics.FillRectangle(back, e.Bounds);
            TextRenderer.DrawText(e.Graphics, (string)_category.Items[e.Index]!, _category.Font, new Rectangle(e.Bounds.X + 8, e.Bounds.Y, e.Bounds.Width - 8, e.Bounds.Height), Glass.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left);
        };
        var catHost = new Panel { Dock = DockStyle.Top, Height = 40, BackColor = Glass.InputFill, Padding = new Padding(10, 6, 10, 4), Margin = new Padding(0, 0, 0, 8) };
        catHost.Controls.Add(_category);
        var catLabel = new Label { Text = "WHAT KIND OF PROBLEM IS IT?", AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Font = new Font("Segoe UI", 8f, FontStyle.Bold), Dock = DockStyle.Top, Padding = new Padding(2, 0, 0, 4) };

        // the program list: only for a software problem, searchable, the programs used most recently first
        _all = demoApps ?? AppCatalog.Load();
        _all.Add(new InstalledApp(NoApp, null, null, null));
        _shown = _all;
        _app.Dock = DockStyle.Fill; _appRow.Controls.Add(_app);
        _appList.DrawItem += DrawApp;
        _appList.DataSource = null;
        FillList("");
        _app.Box.GotFocus += (_, _) => { if (_chosen is null) ShowList(true); };
        _app.Box.Click += (_, _) => { if (_chosen is null) ShowList(true); };
        _app.Box.TextChanged += (_, _) => { if (_chosen is not null && _app.Box.Text != _chosen.Name) { _chosen = null; _noApp = false; } if (_chosen is null) { FillList(_app.Box.Text); ShowList(true); } };
        _app.Box.KeyDown += (_, e) =>
        {
            if (e.KeyCode == Keys.Down && _appList.Items.Count > 0) { _appList.SelectedIndex = Math.Min(_appList.Items.Count - 1, _appList.SelectedIndex + 1); e.Handled = true; }
            else if (e.KeyCode == Keys.Up && _appList.Items.Count > 0) { _appList.SelectedIndex = Math.Max(0, _appList.SelectedIndex - 1); e.Handled = true; }
            else if (e.KeyCode == Keys.Enter) { if (_appList.SelectedIndex >= 0) Choose((InstalledApp)_appList.Items[_appList.SelectedIndex]!); e.Handled = e.SuppressKeyPress = true; }
            else if (e.KeyCode == Keys.Escape) { ShowList(false); e.Handled = e.SuppressKeyPress = true; }
        };
        _appList.MouseClick += (_, e) => { var i = _appList.IndexFromPoint(e.Location); if (i >= 0) Choose((InstalledApp)_appList.Items[i]!); };
        _category.SelectedIndexChanged += (_, _) => { var sw = (string?)_category.SelectedItem == "Software Issue"; _appRow.Visible = _softwareOn = sw; if (!sw) { ShowList(false); _chosen = null; _noApp = false; _app.Box.Clear(); } };

        var layout = new BufferedTable { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 6, BackColor = Color.Transparent };
        for (var i = 0; i < 6; i++) layout.RowStyles.Add(i == 3 ? new RowStyle(SizeType.Percent, 100) : new RowStyle(SizeType.AutoSize));
        layout.Controls.Add(Note("Tell us who you are and what is wrong and we will get back to you. This submits a support ticket for " + (status.DeviceName ?? "this computer") + "."), 0, 0);
        var top = new BufferedFlow { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true, Dock = DockStyle.Fill, BackColor = Color.Transparent };
        void Row(Control c, int h) { c.Width = 436; c.Height = h; c.Margin = new Padding(0, 0, 0, 8); top.Controls.Add(c); }
        top.Controls.Add(catLabel); catLabel.Width = 436; catLabel.AutoSize = false; catLabel.Height = 18;
        catHost.Width = 436; catHost.Margin = new Padding(0, 0, 0, 8); top.Controls.Add(catHost);
        _appRow.Width = 436; _appRow.Margin = new Padding(0, 0, 0, 8); top.Controls.Add(_appRow);
        foreach (var i in new[] { _name, _email, _phone, _subject }) Row(i, 38);
        layout.Controls.Add(top, 0, 1);
        layout.Controls.Add(new Label { Text = "WHAT IS WRONG", AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Font = new Font("Segoe UI", 8f, FontStyle.Bold), Margin = new Padding(2, 4, 0, 4) }, 0, 2);
        _text.Dock = DockStyle.Fill; _text.Margin = new Padding(0);
        _stack.Controls.Add(_text); _stack.Controls.Add(_appList);
        layout.Controls.Add(_stack, 0, 3);
        _urgent.Margin = new Padding(2, 10, 0, 0);
        layout.Controls.Add(_urgent, 0, 4);
        var buttons = new BufferedFlow { FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill, AutoSize = true, Margin = new Padding(0, 12, 0, 0), BackColor = Color.Transparent };
        var cancel = new PillButton("Close");
        cancel.Click += (_, _) => Close();
        buttons.Controls.Add(cancel);
        buttons.Controls.Add(_send);
        var bottom = new BufferedFlow { FlowDirection = FlowDirection.TopDown, WrapContents = false, Dock = DockStyle.Fill, AutoSize = true, BackColor = Color.Transparent };
        bottom.Controls.Add(buttons); bottom.Controls.Add(_result);
        layout.Controls.Add(bottom, 0, 5);
        Controls.Add(layout);
        Controls.Add(new Header(ProviderOf(status), Glass.Cyan));
        AcceptButton = null;
        CancelButton = null;
        _send.Click += async (_, _) => await SendAsync();
    }

    /// <summary>The pictures the self-test takes: a software ticket with the program list open.</summary>
    public void ShowSoftwareDemo()
    {
        _category.SelectedItem = "Software Issue"; _appRow.Visible = _softwareOn = true;
        _name.Box.Text = "Sam Rivera"; _email.Box.Text = "sam@acme.example"; _phone.Box.Text = "555-0123";
        ShowList(true);
    }

    private void ShowList(bool on)
    {
        var show = on && _softwareOn;
        _appList.Visible = show;
        _text.Visible = !show;
        if (show) _appList.BringToFront();
    }

    private void FillList(string q)
    {
        q = q.Trim();
        _shown = q.Length == 0 ? _all : _all.Where(a => a.Name.Contains(q, StringComparison.OrdinalIgnoreCase) || (a.Publisher?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)).ToList();
        _appList.BeginUpdate();
        _appList.Items.Clear();
        foreach (var a in _shown) _appList.Items.Add(a);
        _appList.EndUpdate();
        if (_appList.Items.Count > 0) _appList.SelectedIndex = 0;
    }

    private void DrawApp(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0 || e.Index >= _appList.Items.Count) return;
        var a = (InstalledApp)_appList.Items[e.Index]!;
        var sel = (e.State & DrawItemState.Selected) != 0;
        using (var back = new SolidBrush(sel ? Color.FromArgb(70, 60, 140) : Glass.InputFill)) e.Graphics.FillRectangle(back, e.Bounds);
        TextRenderer.DrawText(e.Graphics, a.Name, new Font("Segoe UI", 9.75f, FontStyle.Bold), new Rectangle(e.Bounds.X + 12, e.Bounds.Y + 3, e.Bounds.Width - 20, 18), Glass.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        var sub = a.Name == NoApp ? "The problem is with Windows, or you do not know which program" : string.Join("  ·  ", new[] { a.Publisher, a.UsedText }.Where(x => !string.IsNullOrWhiteSpace(x)));
        TextRenderer.DrawText(e.Graphics, sub, new Font("Segoe UI", 8.25f), new Rectangle(e.Bounds.X + 12, e.Bounds.Y + 21, e.Bounds.Width - 20, 16), Glass.Dim, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }

    private void Choose(InstalledApp a)
    {
        _chosen = a; _noApp = a.Name == NoApp;
        _app.Box.Text = a.Name;
        ShowList(false);
        _subject.Box.Focus();
    }

    private async Task SendAsync()
    {
        var category = (string?)_category.SelectedItem;
        if (category is null) { Say("Please choose what kind of problem it is.", true); return; }
        if (category == "Software Issue" && _chosen is null) { Say("Please choose the program from the list (or \"Windows itself, or not sure\").", true); _app.Box.Focus(); ShowList(true); return; }
        var d = new TrayDetails(_name.Box.Text.Trim(), _email.Box.Text.Trim(), _phone.Box.Text.Trim());
        if (d.Problem(true) is { } bad) { Say(bad, true); return; }
        if (string.IsNullOrWhiteSpace(_text.Box.Text)) { Say("Write what is wrong first.", true); return; }
        d.Save();
        void Lock(bool on) { _send.Enabled = !on; foreach (var i in new[] { _name, _email, _phone, _subject, _text, _app }) i.Box.Enabled = !on; _urgent.Enabled = !on; _category.Enabled = !on; }
        Lock(true);
        Say("Sending...", false);
        var app = category == "Software Issue" ? _chosen : null;
        var r = await _client.CallAsync(new(TrayProtocol.OpHelp, _text.Box.Text, TrayApp.Who, _urgent.Checked, null, _subject.Box.Text.Trim(), 0, d.Email, d.Name, d.Phone, category, app?.Name, app?.Publisher, app?.Version));
        if (r.Ok)
        {
            var number = r.Body is { ValueKind: JsonValueKind.Object } b && b.TryGetProperty("ticket", out var t) && t.TryGetProperty("number", out var n) && n.TryGetInt32(out var num) ? num : 0;
            Say(number > 0 ? $"Your ticket was submitted. Its number is #{number}. We will check your computer straight away; support's replies will appear in this window and be emailed to {d.Email}." : "Your ticket was submitted. We will be in touch.", false);
            _text.Box.Clear(); _subject.Box.Clear();
            _send.Visible = false;
        }
        else
        {
            Say(r.Error ?? "It could not be sent.", true);
            Lock(false);
        }
    }

    private void Say(string text, bool problem) { _result.Text = text; _result.ForeColor = problem ? Glass.Red : Glass.Green; }
}

/// <summary>The conversation: your messages as violet bubbles on the right, support's as glass bubbles on the left.</summary>
internal sealed class BubbleList : Control
{
    private sealed class Item { public bool Mine; public string Label = ""; public string Text = ""; public Size Box; }
    private readonly List<Item> _items = new();
    private int _scroll; // pixels scrolled up from the bottom
    private static readonly Font Body = new("Segoe UI", 9.75f);
    private static readonly Font Small = new("Segoe UI", 8f);
    private const TextFormatFlags Flags = TextFormatFlags.WordBreak | TextFormatFlags.NoPadding | TextFormatFlags.NoPrefix | TextFormatFlags.TextBoxControl;

    public BubbleList()
    {
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
        BackColor = Color.Transparent;
        TabStop = false;
    }

    public void Clear() { _items.Clear(); _scroll = 0; Invalidate(); }

    public void Add(bool mine, string label, string text)
    {
        var stick = _scroll == 0;
        _items.Add(new Item { Mine = mine, Label = label, Text = text });
        if (stick) _scroll = 0;
        Invalidate();
    }

    protected override void OnMouseWheel(MouseEventArgs e) { _scroll = Math.Max(0, _scroll + e.Delta / 2); Invalidate(); base.OnMouseWheel(e); }
    protected override void OnMouseEnter(EventArgs e) { Focus(); base.OnMouseEnter(e); }

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        var maxBubble = (int)(Width * 0.82f);
        var total = 0;
        foreach (var it in _items)
        {
            var sz = TextRenderer.MeasureText(g, it.Text, Body, new Size(maxBubble - 26, 0), Flags);
            it.Box = new Size(Math.Max(48, sz.Width + 28), sz.Height + 20);
            total += 16 + it.Box.Height + 14;
        }
        var overflow = Math.Max(0, total - Height);
        _scroll = Math.Min(_scroll, overflow);
        var y = -(overflow - _scroll);
        g.SetClip(new Rectangle(0, 0, Width, Height));
        if (_items.Count == 0)
            TextRenderer.DrawText(g, "Messages from your IT provider appear here.", Body, new Rectangle(8, 10, Width - 16, 40), Glass.Dim, Flags);
        foreach (var it in _items)
        {
            var x = it.Mine ? Width - it.Box.Width - (overflow > 0 ? 8 : 0) : 0;
            if (y + 16 + it.Box.Height > 0 && y < Height)
            {
                TextRenderer.DrawText(g, it.Label, Small, new Point(x + 4, y), Glass.Dim, TextFormatFlags.NoPadding);
                var r = new RectangleF(x + 0.5f, y + 16.5f, it.Box.Width - 1, it.Box.Height - 1);
                using var path = Glass.Round(r, 16);
                if (it.Mine)
                {
                    using var br = new LinearGradientBrush(r, Color.FromArgb(112, 80, 245), Color.FromArgb(70, 130, 245), 0f); g.FillPath(br, path);
                }
                else
                {
                    using var br = new SolidBrush(Glass.White(40)); g.FillPath(br, path);
                    using var pen = new Pen(Glass.White(46), 1f); g.DrawPath(pen, path);
                }
                TextRenderer.DrawText(g, it.Text, Body, new Rectangle(x + 14, y + 16 + 10, it.Box.Width - 22, it.Box.Height), it.Mine ? Color.White : Glass.Text, Flags);
            }
            y += 16 + it.Box.Height + 14;
        }
        if (overflow > 0)
        {
            var bar = Math.Max(24, Height * Height / Math.Max(1, total));
            var by = (Height - bar) * (1f - (float)_scroll / overflow);
            using var b = new SolidBrush(Glass.White(70)); using var bp = Glass.Round(new RectangleF(Width - 4, by, 3, bar), 1.5f); g.FillPath(b, bp);
        }
    }
}

/// <summary>A box asking who the person is, shown the first time they chat. What they type is kept for next time.</summary>
internal sealed class DetailsPanel : Panel
{
    private readonly PillInput _name = new(false, 120, "Your name");
    private readonly PillInput _phone = new(false, 40, "Your phone number");
    private readonly PillInput _email = new(false, 200, "Your email address (the chat transcript is sent here)");
    private readonly Label _problem = new() { AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = Glass.Red, BackColor = Color.Transparent, Margin = new Padding(0, 8, 0, 0) };
    public event Action? Done;

    public DetailsPanel(string provider)
    {
        Dock = DockStyle.Fill; BackColor = Color.Transparent;
        var saved = TrayDetails.Load();
        _name.Box.Text = saved.Name; _phone.Box.Text = saved.Phone; _email.Box.Text = saved.Email;
        var flow = new BufferedFlow { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Color.Transparent };
        flow.Controls.Add(new Label { Text = $"Before you chat with {provider}, tell them who you are so they can reach you if the chat is cut off. A transcript is emailed to you when the chat ends.", AutoSize = true, MaximumSize = new Size(420, 0), ForeColor = Glass.Dim, BackColor = Color.Transparent, Margin = new Padding(0, 6, 0, 12) });
        foreach (var i in new[] { _name, _phone, _email }) { i.Width = 420; i.Height = 42; i.Margin = new Padding(0, 0, 0, 8); flow.Controls.Add(i); }
        var go = new PillButton("Start chat", true) { Width = 140, Margin = new Padding(0, 8, 0, 0) };
        go.Click += (_, _) =>
        {
            var d = new TrayDetails(_name.Box.Text.Trim(), _email.Box.Text.Trim(), _phone.Box.Text.Trim());
            if (d.Problem(true) is { } bad) { _problem.Text = bad; return; }
            d.Save(); Done?.Invoke();
        };
        flow.Controls.Add(go); flow.Controls.Add(_problem);
        Controls.Add(flow);
    }
}

internal sealed class ChatForm : TrayForm
{
    private readonly TrayClient _client;
    private readonly BubbleList _history = new() { Dock = DockStyle.Fill };
    private readonly PillInput _input = new(false, TrayProtocol.MaxMessageChars, "Type a message");
    private readonly PillButton _send = new("Send", true) { Width = 80, Height = 42 };
    private readonly PillButton _end = new("End chat") { Width = 100, Height = 32, Visible = false };
    private readonly PillButton _again = new("Start a new chat", true) { Width = 170, Height = 36, Visible = false };
    private readonly Label _note = new() { AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, MaximumSize = new Size(330, 0), Margin = new Padding(0, 8, 0, 0) };
    private readonly Timer _poll = new() { Interval = 4000 };
    private readonly HashSet<string> _seen = new();
    private readonly BufferedTable _layout;
    private readonly DetailsPanel _details;
    private readonly string _idle;
    private string? _after;
    private string? _sessionId;
    private bool _busy, _ended;

    public ChatForm(TrayClient client, TrayStatus status) : base("Chat with support", new Size(500, 560))
    {
        _client = client;
        _layout = new BufferedTable { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 4, BackColor = Color.Transparent };
        _layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        _layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        _layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        _layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _history.Margin = new Padding(0, 6, 0, 0);
        _layout.Controls.Add(_history, 0, 0); _layout.SetColumnSpan(_history, 2);
        _input.Dock = DockStyle.Fill; _input.Margin = new Padding(0, 12, 10, 0);
        _layout.Controls.Add(_input, 0, 1);
        _send.Margin = new Padding(0, 12, 0, 0);
        _layout.Controls.Add(_send, 1, 1);
        _idle = string.IsNullOrWhiteSpace(status.Greeting) ? "Support will answer when they can. Press Enter to send." : status.Greeting + " Press Enter to send.";
        _note.Text = _idle;
        _layout.Controls.Add(_note, 0, 2);
        _end.Margin = new Padding(0, 6, 0, 0);
        _layout.Controls.Add(_end, 1, 2);
        _again.Margin = new Padding(0, 4, 0, 0);
        _layout.Controls.Add(_again, 0, 3); _layout.SetColumnSpan(_again, 2);
        _details = new DetailsPanel(ProviderOf(status));
        Controls.Add(_layout);
        Controls.Add(_details);
        Controls.Add(new Header(ProviderOf(status), Glass.Cyan));
        var ready = TrayDetails.Load().Problem(true) is null;
        _details.Visible = !ready; _layout.Visible = ready;
        _details.Done += () =>
        {
            _details.Visible = false; _layout.Visible = true; _input.Box.Focus(); _ = PollAsync(); _poll.Start();
            var d = TrayDetails.Load();
            _ = _client.CallAsync(new(TrayProtocol.OpContact, null, TrayApp.Who, false, null, null, 0, d.Email, d.Name, d.Phone));   // tell support who this is right away
        };
        _send.Click += async (_, _) => await SendAsync();
        _end.Click += async (_, _) => await EndAsync();
        _again.Click += (_, _) => StartOver();
        _input.Box.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; await SendAsync(); } };
        _poll.Tick += async (_, _) => await PollAsync();
        Shown += async (_, _) => { if (_layout.Visible) { _input.Box.Focus(); await PollAsync(); _poll.Start(); } };
        FormClosed += (_, _) => _poll.Stop();
    }

    /// <summary>Made-up lines for the picture the self-test takes.</summary>
    public void ShowDemo()
    {
        _details.Visible = false; _layout.Visible = true; _end.Visible = true;
        Append("support", "Dana (support)", DateTimeOffset.Now.AddMinutes(-9), "Hi! How can we help?");
        Append("you", "You", DateTimeOffset.Now.AddMinutes(-8), "My printer will not print since this morning.");
        Append("support", "Dana (support)", DateTimeOffset.Now.AddMinutes(-2), "Please restart the Print Spooler: press Windows + R, type services.msc and restart Print Spooler. Tell me if that helps.");
    }

    /// <summary>The picture of the box that asks who the person is.</summary>
    public void ShowDetails() { _details.Visible = true; _layout.Visible = false; }

    /// <summary>The picture of a chat that has been ended.</summary>
    public void ShowEnded() { ShowDemo(); ShowEndedState("Chat ended. A transcript was emailed to sam@acme.example."); }

    private void Append(string from, string who, DateTimeOffset at, string text) =>
        _history.Add(from != "support", $"{(from == "support" ? who : "You")} · {at.ToLocalTime():t}", text);

    private void ShowEndedState(string text)
    {
        _ended = true;
        _note.Text = text; _note.ForeColor = Glass.Green;
        _input.Box.Enabled = false; _send.Enabled = false; _end.Visible = false; _again.Visible = true;
    }

    /// <summary>Back to a fresh, empty chat: the next message starts a new one.</summary>
    private void StartOver()
    {
        _ended = false; _sessionId = null; _after = null; _seen.Clear(); _history.Clear();
        _note.Text = _idle; _note.ForeColor = Glass.Dim;
        _input.Box.Enabled = true; _send.Enabled = true; _again.Visible = false; _end.Visible = false;
        _input.Box.Focus();
    }

    private static string EmailLine(JsonElement? e, string by)
    {
        var to = e is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty("emailedTo", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        var st = e is { ValueKind: JsonValueKind.Object } o2 && o2.TryGetProperty("emailStatus", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        var who = by == "technician" ? "Support ended the chat." : by == "idle" ? "The chat ended because nothing was said for a while." : "Chat ended.";
        return st == "sent" && to is not null ? $"{who} A transcript was emailed to {to}." : to is not null ? $"{who} The transcript could not be emailed; support has a copy." : $"{who} Support has a copy of the transcript.";
    }

    private async Task PollAsync()
    {
        if (_busy || IsDisposed) return;
        _busy = true;
        try
        {
            var r = await _client.CallAsync(new(TrayProtocol.OpChatGet, null, null, false, _after));
            if (!r.Ok) { if (!_ended) { _note.Text = r.Error ?? "Not connected."; _note.ForeColor = Glass.Red; } return; }
            if (r.Body is not { ValueKind: JsonValueKind.Object } b) return;
            string? open = b.TryGetProperty("session", out var ses) && ses.ValueKind == JsonValueKind.Object && ses.TryGetProperty("id", out var sid) ? sid.GetString() : null;
            if (open is null)
            {
                // the chat this window was showing is over (ended by support, or after a quiet spell)
                if (_sessionId is not null && !_ended)
                {
                    var by = b.TryGetProperty("lastEnded", out var le) && le.ValueKind == JsonValueKind.Object && le.TryGetProperty("endedBy", out var eb) ? eb.GetString() ?? "" : "";
                    ShowEndedState(EmailLine(b.TryGetProperty("lastEnded", out var le2) ? le2 : null, by));
                }
                return;
            }
            if (_sessionId is not null && _sessionId != open) { _history.Clear(); _seen.Clear(); _after = null; }
            if (_ended && _sessionId == open) return;
            if (_ended) StartOver();
            _sessionId = open; _end.Visible = true;
            _note.ForeColor = Glass.Dim;
            if (b.TryGetProperty("messages", out var arr) && arr.ValueKind == JsonValueKind.Array)
            {
                foreach (var m in arr.EnumerateArray())
                {
                    var id = m.TryGetProperty("id", out var i) ? i.GetString() ?? "" : "";
                    if (!_seen.Add(id)) continue;
                    var from = m.TryGetProperty("from", out var f) ? f.GetString() ?? "" : "";
                    var sender = m.TryGetProperty("sender", out var s) ? s.GetString() ?? "" : "";
                    var atText = m.TryGetProperty("at", out var a) ? a.GetString() : null;
                    var at = DateTimeOffset.TryParse(atText, out var t) ? t : DateTimeOffset.Now;
                    var text = m.TryGetProperty("text", out var x) ? x.GetString() ?? "" : "";
                    Append(from, from == "support" ? (string.IsNullOrWhiteSpace(sender) ? "Your IT provider" : $"{sender} (support)") : "You", at, text);
                    if (!string.IsNullOrEmpty(atText)) _after = atText;
                }
            }
        }
        finally { _busy = false; }
    }

    private async Task EndAsync()
    {
        var d = TrayDetails.Load();
        var ok = MessageBox.Show(string.IsNullOrWhiteSpace(d.Email) ? "End this chat?" : $"End this chat? A transcript will be emailed to {d.Email}.", "End chat", MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (ok != DialogResult.Yes) return;
        _end.Enabled = false;
        var r = await _client.CallAsync(new(TrayProtocol.OpChatEnd, null, TrayApp.Who, false, null, null, 0, null, d.Name, null));
        _end.Enabled = true;
        if (!r.Ok) { _note.Text = r.Error ?? "The chat could not be ended."; _note.ForeColor = Glass.Red; return; }
        var to = r.Body is { ValueKind: JsonValueKind.Object } o && o.TryGetProperty("emailTo", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        var st = r.Body is { ValueKind: JsonValueKind.Object } o2 && o2.TryGetProperty("emailStatus", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        ShowEndedState(st == "sent" && to is not null ? $"Chat ended. A transcript was emailed to {to}." : to is not null ? "Chat ended. The transcript could not be emailed; support has a copy." : "Chat ended. Support has a copy of the transcript.");
    }

    private async Task SendAsync()
    {
        var text = _input.Box.Text.Trim();
        if (text.Length == 0 || _ended) return;
        _send.Enabled = false;
        var d = TrayDetails.Load();
        var r = await _client.CallAsync(new(TrayProtocol.OpChatSend, text, TrayApp.Who, false, null, null, 0, d.Email, d.Name, d.Phone));
        _send.Enabled = !_ended;
        if (!r.Ok) { _note.Text = r.Error ?? "It could not be sent."; _note.ForeColor = Glass.Red; return; }
        _input.Box.Clear();
        _input.Box.Focus();
        await PollAsync();
    }
}

/// <summary>Asks why, when a person marks a ticket solved. It will not go on without a reason.</summary>
internal sealed class ReasonDialog : Form
{
    private readonly PillInput _reason = new(true, TrayProtocol.MaxMessageChars, "Why is this solved?");
    private readonly Label _problem = new() { AutoSize = true, ForeColor = Glass.Red, BackColor = Color.Transparent, MaximumSize = new Size(400, 0) };
    public string Reason => _reason.Box.Text.Trim();

    public ReasonDialog(string title)
    {
        Text = "Mark as solved"; FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false; ShowInTaskbar = false; StartPosition = FormStartPosition.CenterParent;
        ClientSize = new Size(440, 300); BackColor = Glass.Bottom; Font = new Font("Segoe UI", 9.5f); DoubleBuffered = true;
        var head = new Label { Text = title, AutoSize = true, MaximumSize = new Size(400, 0), ForeColor = Glass.Text, BackColor = Color.Transparent, Font = new Font("Segoe UI", 11f, FontStyle.Bold), Location = new Point(20, 18) };
        var note = new Label { Text = "Tell support why this is solved. They will see it on the ticket. You can reply later if the problem comes back.", AutoSize = true, MaximumSize = new Size(400, 0), ForeColor = Glass.Dim, BackColor = Color.Transparent, Location = new Point(20, 50) };
        _reason.Location = new Point(20, 98); _reason.Size = new Size(400, 120);
        _problem.Location = new Point(20, 226);
        var ok = new PillButton("Mark as solved", true) { Location = new Point(20, 250), Width = 150 };
        var cancel = new PillButton("Cancel") { Location = new Point(180, 250), Width = 100 };
        ok.Click += (_, _) => { if (Reason.Length < 3) { _problem.Text = "Please say why this is solved."; return; } DialogResult = DialogResult.OK; Close(); };
        cancel.Click += (_, _) => { DialogResult = DialogResult.Cancel; Close(); };
        Controls.AddRange(new Control[] { head, note, _reason, _problem, ok, cancel });
        CancelButton = null;
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        using var br = new LinearGradientBrush(ClientRectangle, Glass.Top, Glass.Bottom, 90f); g.FillRectangle(br, ClientRectangle);
        using var tab = new LinearGradientBrush(new Rectangle(26, 0, 54, 3), Glass.Violet, Glass.Cyan, 0f); using var tp = Glass.Round(new RectangleF(26, -2, 54, 5), 1.5f); g.FillPath(tab, tp);
    }

    protected override void OnShown(EventArgs e) { base.OnShown(e); _reason.Box.Focus(); }
}

/// <summary>One ticket's conversation: what the person wrote, what support wrote back, and a box to answer.</summary>
internal sealed class TicketForm : TrayForm
{
    private readonly TrayClient _client;
    private readonly int _number;
    private readonly BubbleList _history = new() { Dock = DockStyle.Fill };
    private readonly PillInput _input = new(false, TrayProtocol.MaxMessageChars, "Write a reply");
    private readonly PillButton _send = new("Send", true) { Width = 80, Height = 42 };
    private readonly PillButton _solved = new("Mark as solved") { Width = 140, Height = 32 };
    private readonly Panel _verdict = new() { Dock = DockStyle.Top, Height = 78, Visible = false, BackColor = Color.Transparent };
    private readonly PillButton _fixed = new("It's fixed", true) { Width = 130, Height = 34 };
    private readonly PillButton _still = new("Still not working") { Width = 160, Height = 34 };
    private readonly Label _note = new() { AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, MaximumSize = new Size(300, 0), Margin = new Padding(0, 8, 0, 0) };
    private readonly Label _subject = new() { AutoSize = true, MaximumSize = new Size(440, 0), ForeColor = Glass.Dim, BackColor = Color.Transparent, Dock = DockStyle.Top, Padding = new Padding(0, 4, 0, 6) };
    private readonly Timer _poll = new() { Interval = 8000 };
    private readonly HashSet<string> _seen = new();
    private bool _busy, _closed;

    public TicketForm(TrayClient client, TrayStatus status, int number, string subject) : base($"Ticket #{number}", new Size(500, 580))
    {
        _client = client; _number = number;
        _subject.Text = subject;
        var layout = new BufferedTable { Dock = DockStyle.Fill, ColumnCount = 2, RowCount = 3, BackColor = Color.Transparent };
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        layout.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        layout.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        layout.RowStyles.Add(new RowStyle(SizeType.Absolute, 54));
        layout.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        _history.Margin = new Padding(0, 6, 0, 0);
        layout.Controls.Add(_history, 0, 0); layout.SetColumnSpan(_history, 2);
        _input.Dock = DockStyle.Fill; _input.Margin = new Padding(0, 12, 10, 0);
        layout.Controls.Add(_input, 0, 1);
        _send.Margin = new Padding(0, 12, 0, 0);
        layout.Controls.Add(_send, 1, 1);
        _note.Text = "Replies from support appear here. Press Enter to send.";
        layout.Controls.Add(_note, 0, 2);
        _solved.Margin = new Padding(0, 6, 0, 0);
        layout.Controls.Add(_solved, 1, 2);
        _solved.Click += async (_, _) => await ResolveAsync();
        var ask = new Label { Text = "We ran an automatic repair on your computer. Please test it. Did it fix the problem?", AutoSize = true, MaximumSize = new Size(430, 0), ForeColor = Glass.Cyan, BackColor = Color.Transparent, Location = new Point(0, 2) };
        _fixed.Location = new Point(0, 40); _still.Location = new Point(140, 40);
        _verdict.Controls.AddRange(new Control[] { ask, _fixed, _still });
        _fixed.Click += async (_, _) => await VerdictAsync(true);
        _still.Click += async (_, _) => await VerdictAsync(false);
        Controls.Add(layout);
        Controls.Add(_verdict);
        Controls.Add(_subject);
        Controls.Add(new Header($"Ticket #{number}", Glass.Cyan));
        _send.Click += async (_, _) => await SendAsync();
        _input.Box.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter && !e.Shift) { e.SuppressKeyPress = true; await SendAsync(); } };
        _poll.Tick += async (_, _) => await PollAsync();
        Shown += async (_, _) => { _input.Box.Focus(); await PollAsync(); _poll.Start(); };
        FormClosed += (_, _) => _poll.Stop();
    }

    public void ShowDemo()
    {
        _history.Add(true, $"You · {DateTimeOffset.Now.AddHours(-3):t}", "Outlook keeps crashing when I open an attachment.");
        _history.Add(false, $"Dana (support) · {DateTimeOffset.Now.AddMinutes(-3):t}", "Please send me the error message you see when Outlook closes.");
    }

    private async Task PollAsync()
    {
        if (_busy || IsDisposed) return;
        _busy = true;
        try
        {
            var r = await _client.CallAsync(new(TrayProtocol.OpTicketGet, null, null, false, null, null, _number));
            if (!r.Ok) { _note.Text = r.Error ?? "Not connected."; _note.ForeColor = Glass.Red; return; }
            _note.ForeColor = Glass.Dim;
            if (r.Body is not { ValueKind: JsonValueKind.Object } b) return;
            if (b.TryGetProperty("ticket", out var tk) && tk.TryGetProperty("status", out var st))
            {
                _closed = st.GetString() == "closed";
                _input.Box.Enabled = !_closed; _send.Enabled = !_closed;
                _solved.Visible = st.GetString() is not ("closed" or "resolved");
                _verdict.Visible = tk.TryGetProperty("autoRepair", out var ar) && ar.ValueKind == JsonValueKind.String && ar.GetString() == "awaiting_user" && !_closed;
                _note.Text = _closed ? "This ticket is closed. Submit a new ticket from the main window if you still need help." : st.GetString() == "resolved" ? "Support marked this solved. Reply if it is not." : "Replies from support appear here. Press Enter to send.";
            }
            if (b.TryGetProperty("messages", out var arr) && arr.ValueKind == JsonValueKind.Array)
                foreach (var m in arr.EnumerateArray())
                {
                    var id = m.TryGetProperty("id", out var i) ? i.GetString() ?? "" : "";
                    if (!_seen.Add(id)) continue;
                    var mine = (m.TryGetProperty("from", out var f) ? f.GetString() : "") != "support";
                    var sender = m.TryGetProperty("sender", out var s) ? s.GetString() ?? "" : "";
                    var at = DateTimeOffset.TryParse(m.TryGetProperty("at", out var a) ? a.GetString() : null, out var t) ? t : DateTimeOffset.Now;
                    var text = m.TryGetProperty("text", out var x) ? x.GetString() ?? "" : "";
                    _history.Add(mine, $"{(mine ? "You" : string.IsNullOrWhiteSpace(sender) ? "Support" : $"{sender} (support)")} · {at.ToLocalTime():t}", text);
                }
        }
        finally { _busy = false; }
    }

    /// <summary>After an automatic repair: it is fixed (the ticket is solved), or it is still not working (a technician takes over).</summary>
    private async Task VerdictAsync(bool fixedNow)
    {
        _fixed.Enabled = _still.Enabled = false;
        var d = TrayDetails.Load();
        var r = fixedNow
            ? await _client.CallAsync(new(TrayProtocol.OpTicketResolve, "It works now after the automatic repair.", TrayApp.Who, false, null, null, _number, null, d.Name, null))
            : await _client.CallAsync(new(TrayProtocol.OpTicketReply, "The problem is still there after the automatic repair.", TrayApp.Who, false, null, null, _number, null, d.Name, null));
        _fixed.Enabled = _still.Enabled = true;
        if (!r.Ok) { _note.Text = r.Error ?? "It could not be sent."; _note.ForeColor = Glass.Red; return; }
        _verdict.Visible = false;
        _note.Text = fixedNow ? "Thank you. The ticket is marked as solved." : "Thank you. A technician has been told and will investigate."; _note.ForeColor = Glass.Green;
        await PollAsync();
    }

    private async Task ResolveAsync()
    {
        using var dlg = new ReasonDialog($"Mark ticket #{_number} as solved?");
        if (dlg.ShowDialog(this) != DialogResult.OK) return;
        _solved.Enabled = false;
        var d = TrayDetails.Load();
        var r = await _client.CallAsync(new(TrayProtocol.OpTicketResolve, dlg.Reason, TrayApp.Who, false, null, null, _number, null, d.Name, null));
        _solved.Enabled = true;
        if (!r.Ok) { _note.Text = r.Error ?? "It could not be marked as solved."; _note.ForeColor = Glass.Red; return; }
        _note.Text = "Marked as solved. Reply here if the problem comes back."; _note.ForeColor = Glass.Green;
        _solved.Visible = false;
        await PollAsync();
    }

    private async Task SendAsync()
    {
        var text = _input.Box.Text.Trim();
        if (text.Length == 0 || _closed) return;
        _send.Enabled = false;
        var d = TrayDetails.Load();
        var r = await _client.CallAsync(new(TrayProtocol.OpTicketReply, text, TrayApp.Who, false, null, null, _number, null, d.Name, null));
        _send.Enabled = !_closed;
        if (!r.Ok) { _note.Text = r.Error ?? "It could not be sent."; _note.ForeColor = Glass.Red; return; }
        _input.Box.Clear();
        _input.Box.Focus();
        await PollAsync();
    }
}

/// <summary>The window that tells a person support has written back. It sits on top of what they are doing with a sound and stays until they open it or dismiss it.</summary>
internal sealed class ReplyAlert : Form
{
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    private readonly Action _open;

    public ReplyAlert(string title, string text, Action open)
    {
        _open = open;
        FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
        ClientSize = new Size(400, 168); BackColor = Glass.Bottom; Font = new Font("Segoe UI", 9.5f); DoubleBuffered = true;
        var t = new Label { Text = title, AutoSize = true, MaximumSize = new Size(360, 0), Font = new Font("Segoe UI", 11f, FontStyle.Bold), ForeColor = Glass.Text, BackColor = Color.Transparent, Location = new Point(22, 20) };
        var b = new Label { Text = text.Length > 160 ? text[..159] + "..." : text, AutoSize = false, Size = new Size(358, 60), ForeColor = Glass.Dim, BackColor = Color.Transparent, Location = new Point(22, 50) };
        var open2 = new PillButton("Open", true) { Location = new Point(22, 118), Width = 120 };
        var later = new PillButton("Dismiss") { Location = new Point(152, 118), Width = 110 };
        open2.Click += (_, _) => { Close(); _open(); };
        later.Click += (_, _) => Close();
        Controls.AddRange(new Control[] { t, b, open2, later });
        Region = new Region(Glass.Round(new RectangleF(0, 0, Width, Height), 16));
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams { get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00000008; return cp; } }   // no activate, topmost

    public void ShowAlert()
    {
        var area = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1280, 720);
        Location = new Point(area.Right - Width - 16, area.Bottom - Height - 16);
        try { System.Media.SystemSounds.Exclamation.Play(); } catch { /* no sound device */ }
        Show();
        SetWindowPos(Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);   // topmost, not moved, not resized, not activated
    }

    protected override void OnPaintBackground(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        using (var br = new LinearGradientBrush(ClientRectangle, Glass.Top, Glass.Bottom, 90f)) g.FillRectangle(br, ClientRectangle);
        using var pen = new Pen(Glass.White(80), 1f); using var path = Glass.Round(new RectangleF(0.5f, 0.5f, Width - 2, Height - 2), 16); g.DrawPath(pen, path);
        using var tab = new LinearGradientBrush(new Rectangle(26, 0, 54, 3), Glass.Amber, Glass.Red, 0f); using var tp = Glass.Round(new RectangleF(26, -2, 54, 5), 1.5f); g.FillPath(tab, tp);
    }

    protected override void OnClick(EventArgs e) { base.OnClick(e); Close(); _open(); }
}

/// <summary>One ticket in the list on the main window.</summary>
internal sealed class TicketRow : Control
{
    private bool _hover;
    private TrayStatus.TicketItem _t;

    public TicketRow(TrayStatus.TicketItem t, Action<int> open)
    {
        _t = t;
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.SupportsTransparentBackColor | ControlStyles.ResizeRedraw, true);
        BackColor = Color.Transparent; Height = 58; Width = 410; Cursor = Cursors.Hand; Margin = new Padding(0, 0, 0, 8); TabStop = true;
        Click += (_, _) => open(t.Number);
        KeyDown += (_, e) => { if (e.KeyCode is Keys.Enter or Keys.Space) open(t.Number); };
    }

    public int Number => _t.Number;

    /// <summary>New facts about the same ticket: it is redrawn only when something about it is different.</summary>
    public void UpdateItem(TrayStatus.TicketItem t) { if (t == _t) return; _t = t; Invalidate(); }

    protected override bool IsInputKey(Keys k) => k is Keys.Enter or Keys.Space || base.IsInputKey(k);
    protected override void OnMouseEnter(EventArgs e) { _hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { _hover = false; Invalidate(); base.OnMouseLeave(e); }

    private static string StatusText(string s) => s switch { "open" => "Waiting for us", "in_progress" => "Being worked on", "pending" => "Waiting for you", "resolved" => "Solved", _ => s };

    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; Glass.Smooth(g);
        var r = new RectangleF(0.5f, 0.5f, Width - 2, Height - 2);
        using var path = Glass.Round(r, 14);
        using (var b = new SolidBrush(Glass.White(_hover ? 34 : 20))) g.FillPath(b, path);
        using (var pen = new Pen(_t.Unread ? Color.FromArgb(200, Glass.Amber) : Glass.White(46), 1f)) g.DrawPath(pen, path);
        if (_t.Unread) { using var d = new SolidBrush(Glass.Amber); g.FillEllipse(d, 14, 14, 9, 9); }
        var x = _t.Unread ? 32 : 16;
        TextRenderer.DrawText(g, $"#{_t.Number}  {_t.Subject}", new Font("Segoe UI", 9.5f, FontStyle.Bold), new Rectangle(x, 8, Width - x - 12, 22), Glass.Text, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        TextRenderer.DrawText(g, _t.AutoRepair == "awaiting_user" ? "Automatic repair done  ·  please test it" : _t.Unread ? $"{StatusText(_t.Status)}  ·  New reply from support" : StatusText(_t.Status), new Font("Segoe UI", 8.5f), new Rectangle(x, 32, Width - x - 12, 18), _t.AutoRepair == "awaiting_user" ? Glass.Cyan : _t.Unread ? Glass.Amber : Glass.Dim, TextFormatFlags.EndEllipsis | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
    }
}

/// <summary>What a left click opens: the ways to reach support, then this computer's state.</summary>
internal sealed class HomeForm : TrayForm
{
    private readonly BufferedTable _grid = new() { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, BackColor = Color.Transparent };
    private readonly Label _greeting = new() { AutoSize = true, MaximumSize = new Size(410, 0), ForeColor = Glass.Dim, BackColor = Color.Transparent, Margin = new Padding(0, 4, 0, 0) };
    private readonly PillButton _ticket = new("Submit a support ticket", true) { Width = 410, Height = 44 };
    private readonly PillButton _chat = new("Chat with support") { Width = 410, Height = 44 };
    private readonly BufferedFlow _top = new() { Dock = DockStyle.Top, AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Color.Transparent };
    private readonly Label _contact = new() { AutoSize = true, MaximumSize = new Size(410, 0), ForeColor = Glass.Dim, BackColor = Color.Transparent, Margin = new Padding(0, 14, 0, 0) };
    private readonly Label _notice = new() { AutoSize = true, MaximumSize = new Size(390, 0), ForeColor = Glass.Amber, BackColor = Color.Transparent, Margin = new Padding(0), Font = new Font("Segoe UI", 9.5f, FontStyle.Bold) };
    private readonly Panel _noticeBox = new() { AutoSize = true, Padding = new Padding(10, 6, 10, 6), BackColor = Color.FromArgb(40, 251, 191, 36), Margin = new Padding(0, 10, 0, 0), Visible = false };
    private readonly LinkLabel _site = new() { AutoSize = true, MaximumSize = new Size(410, 0), BackColor = Color.Transparent, LinkColor = Glass.Cyan, ActiveLinkColor = Glass.Violet, VisitedLinkColor = Glass.Cyan, Margin = new Padding(0, 4, 0, 0), LinkBehavior = LinkBehavior.HoverUnderline };
    private readonly Header _head;
    private string? _phone, _email;

    private readonly BufferedFlow _tickets = new() { Dock = DockStyle.Top, Height = 66, FlowDirection = FlowDirection.TopDown, WrapContents = false, BackColor = Color.Transparent, AutoScroll = true };
    private readonly Action<int> _openTicket;

    public HomeForm(TrayStatus s, Action ticket, Action chat, Action<int> openTicket) : base("ADG RMM support", new Size(460, 820))
    {
        _openTicket = openTicket;
        _ticket.Margin = new Padding(0, 14, 0, 0); _chat.Margin = new Padding(0, 10, 0, 0);
        _ticket.Click += (_, _) => ticket(); _chat.Click += (_, _) => chat();
        _noticeBox.Controls.Add(_notice);
        _site.LinkClicked += (_, _) =>
        {
            if (Uri.TryCreate(_site.Text, UriKind.Absolute, out var u) && (u.Scheme == Uri.UriSchemeHttps || u.Scheme == Uri.UriSchemeHttp))
                try { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { /* no browser */ }
        };
        _top.Controls.Add(_noticeBox); _top.Controls.Add(_greeting); _top.Controls.Add(_ticket); _top.Controls.Add(_chat); _top.Controls.Add(_contact); _top.Controls.Add(_site);
        _contact.Cursor = Cursors.Hand;
        _contact.Click += (_, _) => { try { Clipboard.SetText(string.Join("  ", new[] { _phone, _email }.Where(x => !string.IsNullOrWhiteSpace(x)))); } catch { /* clipboard busy */ } };
        _grid.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        _grid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        _grid.Margin = new Padding(0);
        var spacer = new Panel { Dock = DockStyle.Top, Height = 18, BackColor = Color.Transparent };
        var title = new Label { Text = "THIS COMPUTER", AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Font = new Font("Segoe UI", 8f, FontStyle.Bold), Dock = DockStyle.Top, Padding = new Padding(0, 0, 0, 4) };
        // docked controls stack from the last added to the first
        var ticketTitle = new Label { Text = "YOUR TICKETS", AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Font = new Font("Segoe UI", 8f, FontStyle.Bold), Dock = DockStyle.Top, Padding = new Padding(0, 0, 0, 6) };
        var spacer2 = new Panel { Dock = DockStyle.Top, Height = 14, BackColor = Color.Transparent };
        Controls.Add(_grid); Controls.Add(title); Controls.Add(spacer2); Controls.Add(_tickets); Controls.Add(ticketTitle); Controls.Add(spacer); Controls.Add(_top);
        _head = new Header(ProviderOf(s), Glass.Cyan);
        Controls.Add(_head);
        Apply(s);
    }

    /// <summary>For the self-test: which controls the ticket list and the status rows are made of (they must stay the same ones across updates).</summary>
    public int[] ControlIdentity() => _tickets.Controls.Cast<Control>().Concat(_grid.Controls.Cast<Control>()).Select(c => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(c)).ToArray();

    private string _shown = "";
    private readonly Dictionary<string, (Label Key, Label Val)> _statusRows = new();
    private readonly Label _noTickets = new() { Text = "You have no open tickets.", AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Visible = false };

    private static (string Key, string Value, Color Color)[] StatusRows(TrayStatus s)
    {
        var ago = s.LastCheckIn is null ? null : DateTimeOffset.Now - s.LastCheckIn;
        return new[]
        {
            ("Computer", s.DeviceName ?? "", Glass.Text),
            ("Belongs to", string.IsNullOrWhiteSpace(s.Customer) ? "" : s.Customer + (string.IsNullOrWhiteSpace(s.Site) ? "" : $", {s.Site}"), Glass.Text),
            ("Connected to support", ago is null ? "Not yet" : ago.Value.TotalMinutes < 15 ? "Yes (checked in a moment ago)" : $"Last checked in {(int)ago.Value.TotalHours} hours ago", ago is null || ago.Value.TotalMinutes >= 15 ? Glass.Red : Glass.Green),
            ("Support software", s.AgentVersion is null ? "" : $"Version {s.AgentVersion}", Glass.Text),
            ("Problems found", s.OpenAlerts == 0 ? "None" : s.OpenAlerts == 1 ? "1 (support has been told)" : $"{s.OpenAlerts} (support has been told)", s.OpenAlerts == 0 ? Glass.Green : Glass.Amber),
        };
    }

    /// <summary>Brings the window up to date. It is called every time the tray asks the server, so it changes nothing at all when nothing is different, and otherwise only the text or row that is, in place: no controls are rebuilt, so nothing flickers.</summary>
    public void Apply(TrayStatus s)
    {
        var tickets = s.Tickets ?? Array.Empty<TrayStatus.TicketItem>();
        var rows = StatusRows(s);
        var sig = string.Join("\u001f", new[] { ProviderOf(s), s.Notice, s.Greeting, s.HelpEnabled.ToString(), s.ChatEnabled.ToString(), s.Unread.ToString(), s.Phone, s.Email, s.Contact, s.AfterHoursPhone, s.Hours, s.Website }.Select(x => x ?? ""))
            + "\u001e" + string.Join("\u001f", rows.Select(r => $"{r.Key}={r.Value}/{r.Color.ToArgb()}"))
            + "\u001e" + string.Join("\u001f", tickets.Select(t => $"{t.Number}|{t.Subject}|{t.Status}|{t.Unread}|{t.AutoRepair}"));
        if (sig == _shown) return;
        _shown = sig;

        if (_head.Text != ProviderOf(s)) { _head.Text = ProviderOf(s); _head.Invalidate(); }
        var notice = s.Notice ?? "";
        if (_notice.Text != notice) _notice.Text = notice;
        var showNotice = !string.IsNullOrWhiteSpace(s.Notice);
        if (_noticeBox.Visible != showNotice) _noticeBox.Visible = showNotice;
        var greeting = string.IsNullOrWhiteSpace(s.Greeting) ? "How can we help?" : s.Greeting;
        if (_greeting.Text != greeting) _greeting.Text = greeting;
        if (_ticket.Visible != s.HelpEnabled) _ticket.Visible = s.HelpEnabled;
        if (_chat.Visible != s.ChatEnabled) _chat.Visible = s.ChatEnabled;
        var chatText = s.Unread > 0 ? $"Chat with support ({s.Unread} new)" : "Chat with support";
        if (_chat.Text != chatText) { _chat.Text = chatText; _chat.Invalidate(); }
        _phone = s.Phone; _email = s.Email;
        var lines = new List<string>();
        if (!string.IsNullOrWhiteSpace(s.Contact)) lines.Add($"Point of contact  {s.Contact}");
        if (!string.IsNullOrWhiteSpace(s.Phone)) lines.Add($"Phone  {s.Phone}");
        if (!string.IsNullOrWhiteSpace(s.AfterHoursPhone)) lines.Add($"After hours  {s.AfterHoursPhone}");
        if (!string.IsNullOrWhiteSpace(s.Email)) lines.Add($"Email  {s.Email}");
        if (!string.IsNullOrWhiteSpace(s.Hours)) lines.Add($"Office hours  {s.Hours}");
        var contact = string.Join("\n", lines);
        if (_contact.Text != contact) _contact.Text = contact;
        if (_contact.Visible != (lines.Count > 0)) _contact.Visible = lines.Count > 0;
        var web = Uri.TryCreate(s.Website, UriKind.Absolute, out var wu) && (wu.Scheme == Uri.UriSchemeHttps || wu.Scheme == Uri.UriSchemeHttp) ? wu.AbsoluteUri : null;
        if (_site.Text != (web ?? ""))
        {
            _site.Text = web ?? ""; _site.Links.Clear(); if (web is not null) _site.Links.Add(0, web.Length);
        }
        if (_site.Visible != (web is not null)) _site.Visible = web is not null;

        // the computer's state: five fixed rows whose text and colour are changed in place
        foreach (var (key, value, color) in rows)
        {
            if (!_statusRows.TryGetValue(key, out var pair))
            {
                var k = new Label { Text = key, AutoSize = true, ForeColor = Glass.Dim, BackColor = Color.Transparent, Margin = new Padding(0, 5, 22, 5) };
                var v = new Label { AutoSize = true, MaximumSize = new Size(260, 0), BackColor = Color.Transparent, Margin = new Padding(0, 5, 0, 5) };
                _grid.RowCount++;
                _grid.Controls.Add(k, 0, _grid.RowCount - 1);
                _grid.Controls.Add(v, 1, _grid.RowCount - 1);
                _statusRows[key] = pair = (k, v);
            }
            if (pair.Val.Text != value) pair.Val.Text = value;
            if (pair.Val.ForeColor != color) pair.Val.ForeColor = color;
            var show = value.Length > 0 || key == "Computer";
            if (pair.Key.Visible != show) { pair.Key.Visible = show; pair.Val.Visible = show; }
        }

        // the tickets: the same tickets in the same order are updated in place; only a different list is rebuilt
        var current = _tickets.Controls.OfType<TicketRow>().ToList();
        var same = current.Count == tickets.Count && current.Select(r => r.Number).SequenceEqual(tickets.Select(t => t.Number));
        var rowWidth = tickets.Count > 4 ? 390 : 410;
        var height = Math.Max(30, Math.Min(tickets.Count, 4) * 66);
        if (same)
        {
            for (var i = 0; i < current.Count; i++) { current[i].UpdateItem(tickets[i]); if (current[i].Width != rowWidth) current[i].Width = rowWidth; }
        }
        else
        {
            _tickets.SuspendLayout();
            foreach (var r in current) { _tickets.Controls.Remove(r); r.Dispose(); }
            if (!_tickets.Controls.Contains(_noTickets)) _tickets.Controls.Add(_noTickets);
            foreach (var t in tickets) { var row = new TicketRow(t, _openTicket) { Width = rowWidth }; _tickets.Controls.Add(row); }
            _tickets.ResumeLayout();
        }
        if (_noTickets.Visible != (tickets.Count == 0)) _noTickets.Visible = tickets.Count == 0;
        if (_tickets.Height != height) _tickets.Height = height;
    }

    private static string Describe(string status) => status switch
    {
        "open" => "Waiting for us",
        "in_progress" => "Being worked on",
        "pending" => "Waiting for you",
        "resolved" => "Solved",
        "closed" => "Closed",
        _ => status,
    };
}
