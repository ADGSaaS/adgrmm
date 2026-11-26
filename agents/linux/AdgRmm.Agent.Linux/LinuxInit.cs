// What starts services on this machine (systemd, or OpenRC as on Alpine) and which C library it has. The agent adapts to both: the
// installer writes the right service, the updater restarts it the right way, and the service checks read the right tool.
using System.Runtime.InteropServices;

namespace AdgRmm.Agent.Linux;

internal static class LinuxInit
{
    /// <summary>True when the machine was booted by systemd (the same test systemd's own tools use).</summary>
    public static bool IsSystemd => Directory.Exists("/run/systemd/system");

    /// <summary>OpenRC: no systemd, and the OpenRC tools are present.</summary>
    public static bool IsOpenRc =>
        !IsSystemd && (File.Exists("/sbin/openrc-run") || File.Exists("/usr/sbin/openrc-run") || File.Exists("/sbin/rc-service") || File.Exists("/usr/sbin/rc-service"));

    /// <summary>Which of the two programs in the package this one is: the runtime identifier it was built for says it.</summary>
    public static bool IsMusl => RuntimeInformation.RuntimeIdentifier.Contains("musl", StringComparison.OrdinalIgnoreCase);

    public static string Libc => IsMusl ? "musl" : "glibc";
    public static string Init => IsSystemd ? "systemd" : IsOpenRc ? "openrc" : "other";

    /// <summary>A service name that is safe to turn into a path under /etc/init.d.</summary>
    public static bool IsPlainServiceName(string name) =>
        name.Length is > 0 and <= 128 && name.All(c => char.IsAsciiLetterOrDigit(c) || c is '_' or '.' or '@' or '-') && !name.StartsWith('.');
}
