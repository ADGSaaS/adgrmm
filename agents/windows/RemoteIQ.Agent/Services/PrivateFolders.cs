// RemoteIQ.Agent/Services/PrivateFolders.cs
//
// Folders for anything the agent later runs as SYSTEM (job scripts, downloaded installers, the update script). Only SYSTEM and
// Administrators may change what is in them: a folder a standard user can write to, or created first under a name they could guess,
// would let them swap the content and have it run as SYSTEM.
using System.Security.AccessControl;
using System.Security.Principal;

namespace RemoteIQ.Agent.Services;

public static class PrivateFolders
{
    /// <summary>The agent's data folder (C:\ProgramData\RemoteIQ). The installer limits it to SYSTEM and Administrators.</summary>
    public static string DataDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "RemoteIQ");

    private static readonly SecurityIdentifier LocalSystem = new(WellKnownSidType.LocalSystemSid, null);
    private static readonly SecurityIdentifier Administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
    private static readonly SecurityIdentifier TrustedInstaller = new("S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464");
    private static readonly SecurityIdentifier CreatorOwner = new(WellKnownSidType.CreatorOwnerSid, null);

    // Reading and running are fine for anyone; every other right (write, append, delete, change permissions, take ownership,
    // generic write or all) is not.
    private const uint ReadOnlyRights =
        (uint)(FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize) | 0x80000000u /* GENERIC_READ */ | 0x20000000u /* GENERIC_EXECUTE */;

    /// <summary>SYSTEM and Administrators full control, nothing inherited from the parent.</summary>
    public static DirectorySecurity Restricted()
    {
        var s = new DirectorySecurity();
        s.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        const InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
        s.AddAccessRule(new FileSystemAccessRule(LocalSystem, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        s.AddAccessRule(new FileSystemAccessRule(Administrators, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        // a dev build run by a person (not SYSTEM) must still be able to use what it creates
        if (Self is not null && Self != LocalSystem)
            s.AddAccessRule(new FileSystemAccessRule(Self, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
        return s;
    }

    // The account this process runs as is trusted too: a dev build run by a person gains nothing from its own folders, and as the
    // service that account is SYSTEM anyway.
    private static readonly SecurityIdentifier? Self = WindowsIdentity.GetCurrent().User;

    private static bool Trusted(SecurityIdentifier sid) =>
        sid == LocalSystem || sid == Administrators || sid == TrustedInstaller || (Self is not null && sid == Self);

    /// <summary>True when the folder is owned by SYSTEM, Administrators or TrustedInstaller and nobody else may change anything in it.</summary>
    public static bool IsLockedDown(string dir)
    {
        try
        {
            var sec = new DirectoryInfo(dir).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
            if (sec.GetOwner(typeof(SecurityIdentifier)) is not SecurityIdentifier owner || !Trusted(owner)) return false;
            foreach (FileSystemAccessRule r in sec.GetAccessRules(includeExplicit: true, includeInherited: true, typeof(SecurityIdentifier)))
            {
                if (r.AccessControlType != AccessControlType.Allow) continue;
                // CREATOR OWNER only applies to what someone creates, and only SYSTEM and Administrators can create anything here.
                if (r.IdentityReference is SecurityIdentifier sid && (Trusted(sid) || sid == CreatorOwner)) continue;
                if (((uint)r.FileSystemRights & ~ReadOnlyRights) != 0) return false;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Makes sure <paramref name="dir"/> exists and only SYSTEM and Administrators can change it: created with that ACL when missing,
    /// its ACL replaced when it is looser but still owned by SYSTEM or Administrators. False when it could not be made safe
    /// (for example a folder a user created and owns).
    /// </summary>
    public static bool TryEnsureLockedDown(string dir)
    {
        try
        {
            var info = new DirectoryInfo(dir);
            if (!info.Exists) info.Create(Restricted());
            if (IsLockedDown(dir)) return true;

            var owner = info.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
            if (owner is null || !Trusted(owner)) return false;
            info.SetAccessControl(Restricted());
            return IsLockedDown(dir);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// A new folder with a random name under the temp folder, created with the SYSTEM and Administrators only ACL in the same call,
    /// so there is no moment in which anyone else could put something in it. The caller deletes it.
    /// </summary>
    public static string CreateRandomPrivateDir(string prefix, string? under = null)
    {
        var parent = under ?? Path.GetTempPath();
        var dir = Path.Combine(parent, prefix + Guid.NewGuid().ToString("N"));
        if (Directory.Exists(dir)) throw new IOException("A folder with that random name already exists: " + dir);
        new DirectoryInfo(dir).Create(Restricted());
        if (!IsLockedDown(dir)) throw new IOException("Could not create a private folder: " + dir);
        return dir;
    }

    /// <summary>
    /// Where a job script goes: C:\ProgramData\RemoteIQ\jobs when that folder is (or can be made) private, otherwise a new random private
    /// folder under the temp folder, which the caller deletes afterwards (<paramref name="temporary"/> is then true).
    /// </summary>
    public static string JobsDir(out bool temporary)
    {
        var jobs = Path.Combine(DataDir, "jobs");
        // The data folder itself must be private too, or someone could rename the jobs folder away and put their own in its place.
        if (IsLockedDown(DataDir) && TryEnsureLockedDown(jobs))
        {
            temporary = false;
            return jobs;
        }
        temporary = true;
        return CreateRandomPrivateDir("riq-job-");
    }
}
