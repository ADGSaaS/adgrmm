// Facts about this machine for the health, security and patching reports: operating system, last boot, firmware,
// network adapters, firewall, disk encryption, TPM, Secure Boot and antivirus. The shape is the one the Windows agent
// sends, so the same reports read both. Read-only: nothing here changes a setting. Every probe stands alone and may
// fail; a field it could not read is left out, and the reports show that as "not reported", never as safe.
using System.Diagnostics;
using System.Globalization;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.RegularExpressions;

namespace AdgRmm.Agent.Linux;

internal static class LinuxDeviceFacts
{
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(6);

    /// <summary>Everything this file can read, as one dictionary to merge into the heartbeat facts. Never throws.</summary>
    public static Dictionary<string, object?> Collect()
    {
        var facts = new Dictionary<string, object?>();
        Put(facts, "os", ReadOs);
        Put(facts, "bios", ReadBios);
        Put(facts, "security", ReadSecurity);
        Put(facts, "network", ReadNetwork);
        return facts;
    }

    /// <summary>Added to the hardware block the agent already sends: serial number and graphics adapters.</summary>
    public static (string? Serial, List<string>? Gpu) ReadHardwareExtras()
    {
        string? serial = null;
        foreach (var p in new[] { "/sys/class/dmi/id/product_serial", "/sys/class/dmi/id/board_serial" })
        {
            var s = ReadFile(p);
            if (!string.IsNullOrWhiteSpace(s) && !IsPlaceholder(s)) { serial = s.Trim(); break; }
        }

        List<string>? gpu = null;
        var (code, stdout) = Run("lspci", Array.Empty<string>());
        if (code == 0)
        {
            var found = stdout.Split('\n')
                .Where(l => Regex.IsMatch(l, @"\b(VGA compatible controller|3D controller|Display controller)\b", RegexOptions.IgnoreCase))
                .Select(l => Regex.Replace(l, @"^\S+\s+[^:]+:\s*", "").Trim())
                .Where(l => l.Length > 0)
                .ToList();
            if (found.Count > 0) gpu = found;
        }
        return (serial, gpu);
    }

    /// <summary>Manufacturer and product, as the Windows agent reports them ("LENOVO 20XW"): the product name alone says little.</summary>
    public static string? ReadModel()
    {
        var vendor = Clean(ReadFile("/sys/class/dmi/id/sys_vendor"));
        var product = Clean(ReadFile("/sys/class/dmi/id/product_name")) ?? Clean(ReadFile("/sys/class/dmi/id/board_name"));
        if (product is null) return vendor;
        if (vendor is null || product.StartsWith(vendor, StringComparison.OrdinalIgnoreCase)) return product;
        return $"{vendor} {product}";
    }

    /// <summary>Alpine's "apk list --installed": "name-1.2.3-r0 x86_64 {origin} (licence) [installed]" per package.</summary>
    public static List<(string Name, string Version)> ParseApkList(string text)
    {
        var list = new List<(string, string)>();
        foreach (var raw in text.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var first = raw.Trim().Split(' ', 2)[0];
            // the version is the last two dash-separated parts: "1.36.1" and "r29"
            var parts = first.Split('-');
            if (parts.Length < 3 || !Regex.IsMatch(parts[^1], @"^r\d+$") || !char.IsDigit(parts[^2][0])) continue;
            var name = string.Join('-', parts[..^2]);
            if (name.Length > 0) list.Add((name, $"{parts[^2]}-{parts[^1]}"));
        }
        return list;
    }

    /// <summary>The processor name with its core and thread counts ("Intel(R) Xeon(R) ..., 8C/16T"), like the Windows agent.</summary>
    public static string? ReadCpu() => ParseCpu(ReadFile("/proc/cpuinfo"));

    public static string? ParseCpu(string? cpuinfo)
    {
        if (string.IsNullOrWhiteSpace(cpuinfo)) return null;
        string? name = null;
        var threads = 0;
        var cores = new HashSet<string>();
        string? physical = null;
        foreach (var raw in cpuinfo.Split('\n'))
        {
            var i = raw.IndexOf(':');
            if (i < 0) continue;
            var key = raw[..i].Trim();
            var value = raw[(i + 1)..].Trim();
            if (key == "model name" && name is null && value.Length > 0) name = value;
            else if (key == "processor") threads++;
            else if (key == "physical id") physical = value;
            else if (key == "core id") cores.Add($"{physical ?? "0"}/{value}");
        }
        if (name is null) return null;
        return threads > 0 && cores.Count > 0 ? $"{name}, {cores.Count}C/{threads}T" : name;
    }

    /// <summary>When the machine last started, from the kernel's own uptime (steady even if the clock was stepped).</summary>
    public static DateTimeOffset? ReadLastBoot()
    {
        var text = ReadFile("/proc/uptime");
        var first = text?.Split(' ', StringSplitOptions.RemoveEmptyEntries).FirstOrDefault();
        if (first is null || !double.TryParse(first, NumberStyles.Float, CultureInfo.InvariantCulture, out var seconds) || seconds < 0) return null;
        return DateTimeOffset.UtcNow.AddSeconds(-seconds);
    }

    // ─── Operating system ───────────────────────────────────────────────────

    private static object? ReadOs()
    {
        var rel = ParseKeyValues(ReadFile("/etc/os-release") ?? ReadFile("/usr/lib/os-release"));
        if (rel.Count == 0) return null;

        var name = rel.GetValueOrDefault("PRETTY_NAME") ?? rel.GetValueOrDefault("NAME");
        var version = rel.GetValueOrDefault("VERSION_ID");
        var kernel = ReadFile("/proc/sys/kernel/osrelease")?.Trim();

        DateTimeOffset? installedAt = null;
        try
        {
            // The root file system's creation time is the nearest thing Linux has to an install date.
            var info = new FileInfo("/lost+found");
            if (info.Exists) installedAt = new DateTimeOffset(info.CreationTimeUtc, TimeSpan.Zero);
        }
        catch { /* optional */ }

        return new
        {
            name,
            edition = rel.GetValueOrDefault("VARIANT") ?? rel.GetValueOrDefault("ID"),
            version,
            displayVersion = version,
            build = kernel,
            buildRevision = kernel,
            architecture = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture == System.Runtime.InteropServices.Architecture.Arm64 ? "arm64" : "x64",
            installedAt,
        };
    }

    // ─── Firmware ───────────────────────────────────────────────────────────

    private static object? ReadBios()
    {
        var vendor = Clean(ReadFile("/sys/class/dmi/id/bios_vendor"));
        var version = Clean(ReadFile("/sys/class/dmi/id/bios_version"));
        var rawDate = Clean(ReadFile("/sys/class/dmi/id/bios_date"));
        if (vendor is null && version is null && rawDate is null) return null;

        // The firmware writes MM/DD/YYYY; the reports want yyyy-MM-dd.
        string? date = null;
        if (rawDate is not null && DateTime.TryParseExact(rawDate, new[] { "MM/dd/yyyy", "M/d/yyyy", "yyyy-MM-dd" }, CultureInfo.InvariantCulture, DateTimeStyles.None, out var d))
            date = d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        return new { vendor, version, releaseDate = date };
    }

    // ─── Network ────────────────────────────────────────────────────────────

    private static object? ReadNetwork()
    {
        var gateways = ReadDefaultGateways();
        var list = new List<object>();

        foreach (var ni in NetworkInterface.GetAllNetworkInterfaces())
        {
            if (ni.OperationalStatus != OperationalStatus.Up || ni.NetworkInterfaceType == NetworkInterfaceType.Loopback) continue;
            if (IsVirtualAdapter(ni.Name)) continue;

            var ips = new List<string>();
            foreach (var ua in ni.GetIPProperties().UnicastAddresses)
            {
                if (ua.Address.AddressFamily != AddressFamily.InterNetwork) continue;
                var ip = ua.Address.ToString();
                if (!ip.StartsWith("169.254.")) ips.Add(ip);
            }
            if (ips.Count == 0) continue;

            var mac = string.Join(":", ni.GetPhysicalAddress().GetAddressBytes().Select(b => b.ToString("X2")));
            list.Add(new
            {
                description = ni.Name,
                mac = mac.Length == 0 ? null : mac,
                ipv4 = ips,
                gateway = gateways.GetValueOrDefault(ni.Name),
                dhcp = (bool?)null,
            });
        }

        return list.Count == 0 ? null : list;
    }

    /// <summary>Docker, bridges, virtual ethernet pairs and similar are not what a person means by "the network cards".</summary>
    private static bool IsVirtualAdapter(string name) =>
        Regex.IsMatch(name, @"^(docker|br-|veth|virbr|cni|flannel|cali|vxlan|lxcbr|lxdbr|tun|tap|kube|cilium|weave)", RegexOptions.IgnoreCase);

    private static Dictionary<string, string> ReadDefaultGateways()
    {
        var result = new Dictionary<string, string>();
        var text = ReadFile("/proc/net/route");
        if (text is null) return result;

        foreach (var line in text.Split('\n').Skip(1))
        {
            var p = line.Split('\t', StringSplitOptions.RemoveEmptyEntries);
            // Iface, Destination, Gateway ... the default route has destination 00000000.
            if (p.Length < 3 || p[1] != "00000000" || p[2].Length != 8) continue;
            if (!uint.TryParse(p[2], NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var gw) || gw == 0) continue;
            // The kernel prints the address in host byte order of a little-endian machine.
            result.TryAdd(p[0], $"{gw & 0xFF}.{(gw >> 8) & 0xFF}.{(gw >> 16) & 0xFF}.{(gw >> 24) & 0xFF}");
        }
        return result;
    }

    // ─── Security ───────────────────────────────────────────────────────────

    private static object? ReadSecurity()
    {
        var firewall = ReadFirewall();
        var encryption = ReadEncryption();
        var antivirus = ReadAntivirus();
        var tpm = ReadTpm();
        var secureBoot = ReadSecureBoot();

        if (firewall is null && encryption is null && antivirus is null && tpm is null && secureBoot is null) return null;

        return new
        {
            antivirus,
            firewall,
            // The reports call this field "bitLocker"; on Linux it lists LUKS-encrypted volumes.
            bitLocker = encryption,
            tpm,
            secureBoot,
        };
    }

    /// <summary>Linux has one firewall, not three profiles, so "on" is reported for all of them.</summary>
    private static object? ReadFirewall()
    {
        bool? on = null;

        // The managers first: they say what the person configured.
        if (IsActive("ufw")) on = ufwEnabled();
        else if (IsActive("firewalld")) on = true;

        bool? ufwEnabled()
        {
            var (code, stdout) = Run("ufw", new[] { "status" });
            if (code == 0) return stdout.Contains("Status: active", StringComparison.OrdinalIgnoreCase);
            var conf = ReadFile("/etc/ufw/ufw.conf");
            return conf is null ? null : Regex.IsMatch(conf, @"^ENABLED=yes", RegexOptions.Multiline | RegexOptions.IgnoreCase);
        }

        if (on is null)
        {
            // No manager: look for rules in the kernel's tables.
            var (code, stdout) = Run("nft", new[] { "list", "ruleset" });
            if (code == 0) on = Regex.IsMatch(stdout, @"\bchain\b[\s\S]*?\b(drop|reject)\b|policy (drop|reject)", RegexOptions.IgnoreCase);
            else
            {
                (code, stdout) = Run("iptables", new[] { "-S" });
                if (code == 0)
                    on = stdout.Split('\n').Any(l => Regex.IsMatch(l, @"^-P (INPUT|FORWARD) (DROP|REJECT)")) ||
                         stdout.Split('\n').Count(l => l.StartsWith("-A ")) > 0;
            }
        }

        return on is null ? null : new { domain = on, @private = on, @public = on };
    }

    /// <summary>
    /// Mounted volumes that matter ("/", "/home", "/data") and whether each sits on a LUKS device, found by walking the
    /// device tree from the disk down (LVM or a partition on top of LUKS still counts as encrypted). Root comes first,
    /// because the report judges the first row when it cannot tell which drive holds the system.
    /// </summary>
    private static object? ReadEncryption()
    {
        var (code, stdout) = Run("lsblk", new[] { "-J", "-o", "NAME,TYPE,FSTYPE,MOUNTPOINT" });
        if (code != 0 || string.IsNullOrWhiteSpace(stdout)) return null;

        var volumes = new List<(string Mount, bool Encrypted)>();
        try
        {
            using var doc = System.Text.Json.JsonDocument.Parse(stdout);
            if (!doc.RootElement.TryGetProperty("blockdevices", out var devices)) return null;
            foreach (var d in devices.EnumerateArray()) Walk(d, false, volumes);
        }
        catch { return null; }

        var wanted = volumes.Where(v => v.Mount is "/" or "/home" or "/data").DistinctBy(v => v.Mount).OrderBy(v => v.Mount == "/" ? 0 : 1).ToList();
        if (wanted.Count == 0) return null;

        return wanted
            .Select(v => (object)new { mount = v.Mount, protection = v.Encrypted ? "on" : "off", status = v.Encrypted ? "encrypted (LUKS)" : "not encrypted" })
            .ToList();
    }

    private static void Walk(System.Text.Json.JsonElement node, bool underLuks, List<(string, bool)> found)
    {
        string? Get(string name) => node.TryGetProperty(name, out var v) && v.ValueKind == System.Text.Json.JsonValueKind.String ? v.GetString() : null;

        var luks = underLuks || Get("fstype") == "crypto_LUKS" || Get("type") == "crypt";
        var mount = Get("mountpoint");
        if (!string.IsNullOrEmpty(mount)) found.Add((mount, luks));

        if (node.TryGetProperty("children", out var kids) && kids.ValueKind == System.Text.Json.JsonValueKind.Array)
            foreach (var k in kids.EnumerateArray()) Walk(k, luks, found);
    }

    private static object? ReadTpm()
    {
        if (!Directory.Exists("/sys/class/tpm/tpm0")) return new { present = false, enabled = (bool?)null, activated = (bool?)null, version = (string?)null };
        var version = Clean(ReadFile("/sys/class/tpm/tpm0/tpm_version_major"));
        return new { present = true, enabled = (bool?)true, activated = (bool?)true, version = version is null ? null : version == "2" ? "2.0" : version + ".2" };
    }

    private static bool? ReadSecureBoot()
    {
        if (!Directory.Exists("/sys/firmware/efi")) return null; // legacy BIOS boot and containers have no Secure Boot; that is "not reported", not a failure
        try
        {
            var file = Directory.GetFiles("/sys/firmware/efi/efivars", "SecureBoot-*").FirstOrDefault();
            if (file is null) return null;
            var bytes = File.ReadAllBytes(file);
            // Four bytes of attributes, then one byte of value.
            return bytes.Length >= 5 ? bytes[4] == 1 : null;
        }
        catch { return null; }
    }

    /// <summary>Linux has no Security Center. Only a scanner that is installed and running is reported, and nothing is reported otherwise.</summary>
    private static object? ReadAntivirus()
    {
        var found = new List<object>();

        if (IsActive("clamav-daemon") || IsActive("clamd@scan") || IsActive("clamd"))
        {
            DateTime? newest = null;
            foreach (var dir in new[] { "/var/lib/clamav" })
                try
                {
                    foreach (var f in Directory.GetFiles(dir, "*.c?d"))
                    {
                        var t = File.GetLastWriteTimeUtc(f);
                        if (newest is null || t > newest) newest = t;
                    }
                }
                catch { /* the folder may not exist */ }
            found.Add(new { name = "ClamAV", state = "on", upToDate = newest is null ? (bool?)null : (DateTime.UtcNow - newest.Value).TotalDays <= 3 });
        }
        if (IsActive("sophos-spl") || IsActive("sav-protect")) found.Add(new { name = "Sophos", state = "on", upToDate = (bool?)null });
        if (IsActive("mdatp")) found.Add(new { name = "Microsoft Defender for Endpoint", state = "on", upToDate = (bool?)null });
        if (IsActive("falcon-sensor")) found.Add(new { name = "CrowdStrike Falcon", state = "on", upToDate = (bool?)null });
        if (IsActive("eset") || IsActive("esets")) found.Add(new { name = "ESET", state = "on", upToDate = (bool?)null });

        // A server with no scanner is common and legitimate; the report shows "not reported" rather than a failure.
        return found.Count == 0 ? null : found;
    }

    // ─── Helpers ────────────────────────────────────────────────────────────

    private static void Put(Dictionary<string, object?> facts, string key, Func<object?> read)
    {
        try
        {
            var value = read();
            if (value is not null) facts[key] = value;
        }
        catch { /* leave the field out */ }
    }

    private static bool IsActive(string unit)
    {
        if (!LinuxInit.IsSystemd && LinuxInit.IsOpenRc)
        {
            if (!LinuxInit.IsPlainServiceName(unit) || !File.Exists($"/etc/init.d/{unit}")) return false;
            var (rc, text) = Run("rc-service", new[] { unit, "status" });
            return rc == 0 && text.Contains("started", StringComparison.OrdinalIgnoreCase);
        }

        var (code, stdout) = Run("systemctl", new[] { "is-active", unit });
        return code == 0 && stdout.Trim() == "active";
    }

    private static string? ReadFile(string path)
    {
        try { return File.Exists(path) ? File.ReadAllText(path) : null; }
        catch { return null; }
    }

    private static string? Clean(string? s)
    {
        var t = s?.Trim();
        return string.IsNullOrEmpty(t) || IsPlaceholder(t) ? null : t;
    }

    private static bool IsPlaceholder(string s) =>
        Regex.IsMatch(s.Trim(), @"^(none|n/a|default string|to be filled by o\.e\.m\.|system serial number|not specified|0|unknown)$", RegexOptions.IgnoreCase);

    private static Dictionary<string, string> ParseKeyValues(string? text)
    {
        var d = new Dictionary<string, string>();
        if (text is null) return d;
        foreach (var raw in text.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            var i = line.IndexOf('=');
            if (i <= 0) continue;
            d[line[..i]] = line[(i + 1)..].Trim().Trim('"', '\'');
        }
        return d;
    }

    private static (int Code, string Stdout) Run(string file, string[] args)
    {
        try
        {
            var psi = new ProcessStartInfo(file)
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                StandardOutputEncoding = Encoding.UTF8,
            };
            foreach (var a in args) psi.ArgumentList.Add(a);

            using var proc = Process.Start(psi);
            if (proc is null) return (-1, "");
            var output = proc.StandardOutput.ReadToEndAsync();
            proc.StandardError.ReadToEndAsync();
            if (!proc.WaitForExit(CommandTimeout))
            {
                try { proc.Kill(true); } catch { /* already gone */ }
                return (-1, "");
            }
            return (proc.ExitCode, output.Wait(1000) ? output.Result : "");
        }
        catch
        {
            // The tool is not installed.
            return (-1, "");
        }
    }
}
