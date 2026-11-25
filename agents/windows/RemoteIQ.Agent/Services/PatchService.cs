// RemoteIQ.Agent/Services/PatchService.cs

using System.Runtime.Versioning;
using System.Runtime.InteropServices;

namespace RemoteIQ.Agent.Services;

[SupportedOSPlatform("windows")]
public sealed class PatchService
{
    public sealed record PatchItem(
        string Id,
        string Title,
        string? Severity,
        bool RequiresReboot,
        string[] KbIds
    );

    public List<PatchItem> ScanWindowsUpdates(bool includeOptional)
    {
        // Uses Windows Update Agent COM API (no PS module required)
        var sessionType = Type.GetTypeFromProgID("Microsoft.Update.Session")
                         ?? throw new InvalidOperationException("Windows Update COM API not available (Microsoft.Update.Session).");

        dynamic session = Activator.CreateInstance(sessionType)!;
        dynamic searcher = session.CreateUpdateSearcher();

        // Only software updates not installed (you can expand later)
        string criteria = "IsInstalled=0 and Type='Software'";
        dynamic result = searcher.Search(criteria);

        var list = new List<PatchItem>();

        int count = 0;
        try { count = (int)result.Updates.Count; } catch { /* ignore */ }

        for (int i = 0; i < count; i++)
        {
            dynamic upd = result.Updates.Item(i);

            // Optional filtering: treat “optional” as non-auto-selected
            // Many “optional” updates have AutoSelectOnWebSites=false
            bool autoSelect = false;
            try { autoSelect = (bool)upd.AutoSelectOnWebSites; } catch { /* ignore */ }

            if (!includeOptional && !autoSelect)
                continue;

            string title = "";
            try { title = (string)(upd.Title ?? ""); } catch { /* ignore */ }

            string? severity = null;
            try
            {
                var sev = upd.MsrcSeverity as string;
                severity = string.IsNullOrWhiteSpace(sev) ? null : sev.Trim();
            }
            catch
            {
                // ignore
            }

            // RebootRequired is only meaningful after installing. Before that, this says what to expect.
            bool reboot = false;
            try { reboot = (int)upd.InstallationBehavior.RebootBehavior != 0; } catch { /* ignore */ }

            // KB IDs (may be empty)
            var kbIds = Array.Empty<string>();
            try
            {
                int kbCount = (int)upd.KBArticleIDs.Count;
                if (kbCount > 0)
                {
                    var tmp = new List<string>(kbCount);
                    for (int k = 0; k < kbCount; k++)
                    {
                        var kb = upd.KBArticleIDs.Item(k) as string;
                        if (!string.IsNullOrWhiteSpace(kb))
                            tmp.Add(kb.Trim());
                    }
                    kbIds = tmp.ToArray();
                }
            }
            catch
            {
                // ignore
            }

            // Stable ID: prefer first KB, else UpdateID
            string id;
            if (kbIds.Length > 0)
            {
                var first = kbIds[0];
                id = first.StartsWith("KB", StringComparison.OrdinalIgnoreCase) ? first : $"KB{first}";
            }
            else
            {
                try
                {
                    id = (string)upd.Identity.UpdateID;
                }
                catch
                {
                    // last resort (should be rare)
                    id = Guid.NewGuid().ToString("D");
                }
            }

            list.Add(new PatchItem(
                Id: id,
                Title: title,
                Severity: severity,
                RequiresReboot: reboot,
                KbIds: kbIds
            ));
        }

        return list;
    }

    public (bool ok, string stdout, string? stderr, bool requiresReboot, string[] installed) InstallWindowsUpdatesByIds(string[] ids, bool includeOptional)
    {
        // WUA OperationResultCode: 2 succeeded, 3 succeeded with errors, 4 failed, 5 aborted.
        const int Succeeded = 2;
        const int SucceededWithErrors = 3;

        if (ids is null || ids.Length == 0)
            return (false, "", "No update IDs provided.", false, Array.Empty<string>());

        try
        {
            var sessionType = Type.GetTypeFromProgID("Microsoft.Update.Session")
                             ?? throw new InvalidOperationException("Windows Update COM API not available (Microsoft.Update.Session).");

            dynamic session = Activator.CreateInstance(sessionType)!;
            dynamic searcher = session.CreateUpdateSearcher();

            string criteria = "IsInstalled=0 and Type='Software'";
            dynamic result = searcher.Search(criteria);

            var collType = Type.GetTypeFromProgID("Microsoft.Update.UpdateColl")
                          ?? throw new InvalidOperationException("Windows Update COM API not available (Microsoft.Update.UpdateColl).");

            dynamic updatesToInstall = Activator.CreateInstance(collType)!;
            var selectedIds = new List<string>();

            int count = 0;
            try { count = (int)result.Updates.Count; } catch { /* ignore */ }

            for (int i = 0; i < count; i++)
            {
                dynamic upd = result.Updates.Item(i);

                bool autoSelect = false;
                try { autoSelect = (bool)upd.AutoSelectOnWebSites; } catch { /* ignore */ }

                if (!includeOptional && !autoSelect)
                    continue;

                // Compute id same way as scan
                string computedId = ComputeUpdateId(upd);

                if (ids.Contains(computedId, StringComparer.OrdinalIgnoreCase))
                {
                    // Installing an update whose licence was not accepted fails.
                    try { if (!(bool)upd.EulaAccepted) upd.AcceptEula(); } catch { /* the install reports it */ }

                    updatesToInstall.Add(upd);
                    selectedIds.Add(computedId);
                }
            }

            int toInstall = 0;
            try { toInstall = (int)updatesToInstall.Count; } catch { /* ignore */ }

            if (toInstall == 0)
                return (false, "", "Windows Update no longer offers these updates. Run a new scan.", false, Array.Empty<string>());

            // Download first
            dynamic downloader = session.CreateUpdateDownloader();
            downloader.Updates = updatesToInstall;
            dynamic dlResult = downloader.Download();

            int downloadCode = (int)dlResult.ResultCode;
            if (downloadCode != Succeeded && downloadCode != SucceededWithErrors)
                return (false, "", $"Windows Update could not download the updates (result {downloadCode}).", false, Array.Empty<string>());

            // Install
            dynamic installer = session.CreateUpdateInstaller();
            installer.Updates = updatesToInstall;
            dynamic instResult = installer.Install();

            bool reboot = false;
            try { reboot = (bool)instResult.RebootRequired; } catch { /* ignore */ }

            // Only what actually installed may be reported as installed.
            var installed = new List<string>();
            for (int i = 0; i < toInstall; i++)
            {
                int code = (int)instResult.GetUpdateResult(i).ResultCode;
                if (code == Succeeded || code == SucceededWithErrors) installed.Add(selectedIds[i]);
            }

            int overall = (int)instResult.ResultCode;
            var stdout = $"Installed {installed.Count} of {toInstall} update(s). ResultCode={overall}. RebootRequired={reboot}";
            if (overall == Succeeded) return (true, stdout, null, reboot, installed.ToArray());

            return (false, stdout, $"Windows Update did not install every update (result {overall}).", reboot, installed.ToArray());
        }
        catch (COMException cex)
        {
            return (false, "", $"COM error: {cex.Message}", false, Array.Empty<string>());
        }
        catch (Exception ex)
        {
            return (false, "", ex.Message, false, Array.Empty<string>());
        }
    }

    private static string ComputeUpdateId(dynamic upd)
    {
        try
        {
            // Prefer first KB if available
            int kbCount = 0;
            try { kbCount = (int)upd.KBArticleIDs.Count; } catch { kbCount = 0; }

            if (kbCount > 0)
            {
                var kb0 = upd.KBArticleIDs.Item(0) as string;
                if (!string.IsNullOrWhiteSpace(kb0))
                {
                    var kb = kb0.Trim();
                    return kb.StartsWith("KB", StringComparison.OrdinalIgnoreCase) ? kb : $"KB{kb}";
                }
            }
        }
        catch
        {
            // ignore and fallback
        }

        try
        {
            return (string)upd.Identity.UpdateID;
        }
        catch
        {
            return Guid.NewGuid().ToString("D");
        }
    }
}
