// The starter set for a new organisation's software library: common business programs, grouped by category.
//
// `match` is what a policy looks for inside installed program names (case-insensitive "contains"), so it is the
// shortest distinctive part of the name. `choco` is the Chocolatey community repository package id the agent installs
// with; entries without one can still be required or banned in a policy, they just cannot be installed from here.
// People can edit, delete and add to all of this. Check an id before relying on it.

export const SOFTWARE_CATEGORIES = [
    "Browsers",
    "Remote access",
    "Communication",
    "Office and productivity",
    "Utilities",
    "Developer",
    "Security",
    "Backup",
    "Media",
    "Other",
] as const;
export type SoftwareCategory = (typeof SOFTWARE_CATEGORIES)[number];

export type StarterEntry = { name: string; category: SoftwareCategory; match: string; publisher?: string; choco?: string; winget?: string; linux?: string; notes?: string; chocoInstallArgs?: string };

export const STARTER_CATALOG: readonly StarterEntry[] = [
    // Browsers
    { name: "Google Chrome", category: "Browsers", match: "Google Chrome", publisher: "Google", choco: "googlechrome", winget: "Google.Chrome", linux: "google-chrome-stable" },
    { name: "Mozilla Firefox", category: "Browsers", match: "Mozilla Firefox", publisher: "Mozilla", choco: "firefox", winget: "Mozilla.Firefox", linux: "firefox" },
    { name: "Microsoft Edge", category: "Browsers", match: "Microsoft Edge", publisher: "Microsoft", choco: "microsoft-edge", winget: "Microsoft.Edge" },
    { name: "Brave", category: "Browsers", match: "Brave", publisher: "Brave Software", choco: "brave", winget: "Brave.Brave", chocoInstallArgs: "--system-level", notes: "Per-user installer: without --system-level it installs into the system account's profile when the agent runs it." },
    { name: "Opera", category: "Browsers", match: "Opera", publisher: "Opera Software", choco: "opera", winget: "Opera.Opera" },
    { name: "Vivaldi", category: "Browsers", match: "Vivaldi", publisher: "Vivaldi Technologies", choco: "vivaldi", winget: "VivaldiTechnologies.Vivaldi" },
    { name: "Tor Browser", category: "Browsers", match: "Tor Browser", publisher: "The Tor Project", choco: "tor-browser", notes: "Often banned in managed environments." },

    // Remote access
    { name: "TeamViewer", category: "Remote access", match: "TeamViewer", publisher: "TeamViewer", choco: "teamviewer", winget: "TeamViewer.TeamViewer" },
    { name: "AnyDesk", category: "Remote access", match: "AnyDesk", publisher: "philandro Software", choco: "anydesk", winget: "AnyDeskSoftwareGmbH.AnyDesk" },
    { name: "RustDesk", category: "Remote access", match: "RustDesk", publisher: "RustDesk", choco: "rustdesk", winget: "RustDesk.RustDesk" },
    { name: "TightVNC", category: "Remote access", match: "TightVNC", choco: "tightvnc" },
    { name: "UltraVNC", category: "Remote access", match: "UltraVNC", choco: "ultravnc" },
    { name: "ConnectWise ScreenConnect", category: "Remote access", match: "ScreenConnect", publisher: "ConnectWise" },
    { name: "Splashtop Streamer", category: "Remote access", match: "Splashtop", publisher: "Splashtop" },
    { name: "LogMeIn", category: "Remote access", match: "LogMeIn", publisher: "LogMeIn" },
    { name: "Hamachi", category: "Remote access", match: "Hamachi", publisher: "LogMeIn", notes: "Creates a private network; often banned." },
    { name: "PuTTY", category: "Remote access", match: "PuTTY", publisher: "Simon Tatham", choco: "putty", winget: "PuTTY.PuTTY", linux: "putty" },
    { name: "Citrix Workspace", category: "Remote access", match: "Citrix Workspace", publisher: "Citrix", choco: "citrix-workspace" },

    // Communication
    { name: "Zoom", category: "Communication", match: "Zoom", publisher: "Zoom Video Communications", choco: "zoom", winget: "Zoom.Zoom" },
    { name: "Microsoft Teams", category: "Communication", match: "Teams", publisher: "Microsoft", choco: "microsoft-teams", winget: "Microsoft.Teams" },
    { name: "Slack", category: "Communication", match: "Slack", publisher: "Slack Technologies", choco: "slack", winget: "SlackTechnologies.Slack" },
    { name: "Skype", category: "Communication", match: "Skype", publisher: "Microsoft", choco: "skype" },
    { name: "Discord", category: "Communication", match: "Discord", publisher: "Discord Inc.", choco: "discord", winget: "Discord.Discord" },
    { name: "Webex", category: "Communication", match: "Webex", publisher: "Cisco", choco: "webex" },
    { name: "Signal", category: "Communication", match: "Signal", publisher: "Signal Foundation", choco: "signal", winget: "OpenWhisperSystems.Signal" },
    { name: "WhatsApp Desktop", category: "Communication", match: "WhatsApp", publisher: "WhatsApp" },
    { name: "Telegram Desktop", category: "Communication", match: "Telegram", publisher: "Telegram", choco: "telegram" },

    // Office and productivity
    { name: "Microsoft 365 Apps", category: "Office and productivity", match: "Microsoft 365", publisher: "Microsoft", choco: "office365business", winget: "Microsoft.Office" },
    { name: "LibreOffice", category: "Office and productivity", match: "LibreOffice", publisher: "The Document Foundation", choco: "libreoffice-fresh", winget: "TheDocumentFoundation.LibreOffice", linux: "libreoffice" },
    { name: "Adobe Acrobat Reader", category: "Office and productivity", match: "Adobe Acrobat", publisher: "Adobe", choco: "adobereader", winget: "Adobe.Acrobat.Reader.64-bit" },
    { name: "Foxit PDF Reader", category: "Office and productivity", match: "Foxit", publisher: "Foxit Software", choco: "foxitreader" },
    { name: "SumatraPDF", category: "Office and productivity", match: "SumatraPDF", choco: "sumatrapdf", winget: "SumatraPDF.SumatraPDF" },
    { name: "Notepad++", category: "Office and productivity", match: "Notepad++", publisher: "Notepad++ Team", choco: "notepadplusplus", winget: "Notepad++.Notepad++" },
    { name: "Dropbox", category: "Office and productivity", match: "Dropbox", publisher: "Dropbox", choco: "dropbox", winget: "Dropbox.Dropbox" },
    { name: "Google Drive", category: "Office and productivity", match: "Google Drive", publisher: "Google", choco: "googledrive", winget: "Google.GoogleDrive" },
    { name: "Evernote", category: "Office and productivity", match: "Evernote", choco: "evernote" },
    { name: "Zoom Outlook Plugin", category: "Office and productivity", match: "Zoom Outlook Plugin", publisher: "Zoom Video Communications" },

    // Utilities
    { name: "7-Zip", category: "Utilities", match: "7-Zip", publisher: "Igor Pavlov", choco: "7zip", winget: "7zip.7zip", linux: "p7zip-full" },
    { name: "WinRAR", category: "Utilities", match: "WinRAR", publisher: "win.rar GmbH", choco: "winrar", winget: "RARLab.WinRAR" },
    { name: "WinZip", category: "Utilities", match: "WinZip", publisher: "Corel" },
    { name: "VLC media player", category: "Utilities", match: "VLC", publisher: "VideoLAN", choco: "vlc", winget: "VideoLAN.VLC", linux: "vlc" },
    { name: "Greenshot", category: "Utilities", match: "Greenshot", choco: "greenshot", winget: "Greenshot.Greenshot" },
    { name: "ShareX", category: "Utilities", match: "ShareX", choco: "sharex", winget: "ShareX.ShareX" },
    { name: "Everything", category: "Utilities", match: "Everything", publisher: "voidtools", choco: "everything", winget: "voidtools.Everything" },
    { name: "TreeSize Free", category: "Utilities", match: "TreeSize", publisher: "JAM Software", choco: "treesizefree" },
    { name: "CCleaner", category: "Utilities", match: "CCleaner", publisher: "Piriform", choco: "ccleaner", notes: "Often banned." },
    { name: "Java Runtime Environment", category: "Utilities", match: "Java", publisher: "Oracle", choco: "javaruntime" },
    { name: "WinSCP", category: "Utilities", match: "WinSCP", choco: "winscp", winget: "WinSCP.WinSCP" },
    { name: "FileZilla", category: "Utilities", match: "FileZilla", choco: "filezilla", winget: "TimKosse.FileZilla.Client", linux: "filezilla" },
    { name: "Sysinternals Suite", category: "Utilities", match: "Sysinternals", publisher: "Microsoft", choco: "sysinternals" },
    { name: "Microsoft PowerToys", category: "Utilities", match: "PowerToys", publisher: "Microsoft", choco: "powertoys", winget: "Microsoft.PowerToys" },
    { name: "Windows Terminal", category: "Utilities", match: "Windows Terminal", publisher: "Microsoft", choco: "microsoft-windows-terminal" },
    { name: "Microsoft .NET Desktop Runtime 8", category: "Utilities", match: "Windows Desktop Runtime - 8", publisher: "Microsoft", choco: "dotnet-8.0-desktopruntime" },
    { name: "Microsoft Visual C++ Redistributable", category: "Utilities", match: "Visual C++", publisher: "Microsoft", choco: "vcredist140" },
    { name: "Chocolatey", category: "Utilities", match: "Chocolatey", publisher: "Chocolatey Software" },

    // Developer
    { name: "Git", category: "Developer", match: "Git", publisher: "The Git Development Community", choco: "git", winget: "Git.Git", linux: "git" },
    { name: "Visual Studio Code", category: "Developer", match: "Visual Studio Code", publisher: "Microsoft", choco: "vscode", winget: "Microsoft.VisualStudioCode" },
    { name: "Python", category: "Developer", match: "Python", publisher: "Python Software Foundation", choco: "python", winget: "Python.Python.3.12", linux: "python3" },
    { name: "Node.js", category: "Developer", match: "Node.js", publisher: "Node.js Foundation", choco: "nodejs-lts", winget: "OpenJS.NodeJS.LTS", linux: "nodejs" },
    { name: "Docker Desktop", category: "Developer", match: "Docker Desktop", publisher: "Docker Inc.", choco: "docker-desktop", winget: "Docker.DockerDesktop" },
    { name: "Postman", category: "Developer", match: "Postman", choco: "postman", winget: "Postman.Postman" },
    { name: "GitHub Desktop", category: "Developer", match: "GitHub Desktop", publisher: "GitHub", choco: "github-desktop", winget: "GitHub.GitHubDesktop" },
    { name: "Wireshark", category: "Developer", match: "Wireshark", publisher: "The Wireshark developer community", choco: "wireshark", winget: "WiresharkFoundation.Wireshark", linux: "wireshark" },

    // Security
    { name: "Malwarebytes", category: "Security", match: "Malwarebytes", publisher: "Malwarebytes", choco: "malwarebytes", winget: "Malwarebytes.Malwarebytes" },
    { name: "Bitdefender", category: "Security", match: "Bitdefender", publisher: "Bitdefender" },
    { name: "Sophos", category: "Security", match: "Sophos", publisher: "Sophos" },
    { name: "ESET", category: "Security", match: "ESET", publisher: "ESET" },
    { name: "CrowdStrike Falcon", category: "Security", match: "CrowdStrike", publisher: "CrowdStrike" },
    { name: "SentinelOne", category: "Security", match: "Sentinel Agent", publisher: "SentinelOne" },
    { name: "Webroot", category: "Security", match: "Webroot", publisher: "Webroot" },
    { name: "McAfee", category: "Security", match: "McAfee", publisher: "McAfee", notes: "Often removed in favour of one managed product." },
    { name: "Norton", category: "Security", match: "Norton", publisher: "NortonLifeLock", notes: "Often removed in favour of one managed product." },
    { name: "Kaspersky", category: "Security", match: "Kaspersky", publisher: "Kaspersky" },
    { name: "Avast", category: "Security", match: "Avast", publisher: "Avast", choco: "avast-free-antivirus", notes: "Consumer antivirus; often banned on managed endpoints." },
    { name: "AVG", category: "Security", match: "AVG", publisher: "AVG Technologies", notes: "Consumer antivirus; often banned on managed endpoints." },
    { name: "Bitwarden", category: "Security", match: "Bitwarden", publisher: "Bitwarden Inc.", choco: "bitwarden", winget: "Bitwarden.Bitwarden" },
    { name: "KeePass", category: "Security", match: "KeePass", choco: "keepass", winget: "DominikReichl.KeePass" },
    { name: "1Password", category: "Security", match: "1Password", publisher: "AgileBits", choco: "1password", winget: "AgileBits.1Password" },
    { name: "LastPass", category: "Security", match: "LastPass", publisher: "LogMeIn", choco: "lastpass" },
    { name: "OpenVPN", category: "Security", match: "OpenVPN", publisher: "OpenVPN Inc.", choco: "openvpn", winget: "OpenVPNTechnologies.OpenVPN" },
    { name: "WireGuard", category: "Security", match: "WireGuard", choco: "wireguard", winget: "WireGuard.WireGuard" },
    { name: "Cisco AnyConnect", category: "Security", match: "AnyConnect", publisher: "Cisco" },
    { name: "FortiClient", category: "Security", match: "FortiClient", publisher: "Fortinet" },
    { name: "GlobalProtect", category: "Security", match: "GlobalProtect", publisher: "Palo Alto Networks" },
    { name: "NordVPN", category: "Security", match: "NordVPN", choco: "nordvpn", notes: "Consumer VPN; often banned." },

    // Backup
    { name: "Veeam Agent", category: "Backup", match: "Veeam", publisher: "Veeam Software" },
    { name: "Acronis", category: "Backup", match: "Acronis", publisher: "Acronis" },
    { name: "Datto", category: "Backup", match: "Datto", publisher: "Datto" },
    { name: "Backblaze", category: "Backup", match: "Backblaze", publisher: "Backblaze", choco: "backblaze" },

    // Media and entertainment
    { name: "Spotify", category: "Media", match: "Spotify", publisher: "Spotify AB", choco: "spotify", winget: "Spotify.Spotify" },
    { name: "iTunes", category: "Media", match: "iTunes", publisher: "Apple", choco: "itunes" },
    { name: "Audacity", category: "Media", match: "Audacity", choco: "audacity", winget: "Audacity.Audacity", linux: "audacity" },
    { name: "OBS Studio", category: "Media", match: "OBS Studio", choco: "obs-studio", winget: "OBSProject.OBSStudio", linux: "obs-studio" },
    { name: "HandBrake", category: "Media", match: "HandBrake", choco: "handbrake", winget: "HandBrake.HandBrake", linux: "handbrake" },
    { name: "GIMP", category: "Media", match: "GIMP", choco: "gimp", winget: "GIMP.GIMP", linux: "gimp" },
    { name: "Paint.NET", category: "Media", match: "Paint.NET", choco: "paint.net", winget: "dotPDN.PaintDotNet" },
    { name: "Inkscape", category: "Media", match: "Inkscape", choco: "inkscape", winget: "Inkscape.Inkscape", linux: "inkscape" },
    { name: "Kodi", category: "Media", match: "Kodi", choco: "kodi", winget: "XBMCFoundation.Kodi" },

    // Other: software that is commonly banned
    { name: "uTorrent", category: "Other", match: "uTorrent", publisher: "BitTorrent Inc.", choco: "utorrent", notes: "Often banned." },
    { name: "qBittorrent", category: "Other", match: "qBittorrent", choco: "qbittorrent", winget: "qBittorrent.qBittorrent", linux: "qbittorrent", notes: "Often banned." },
    { name: "BitTorrent", category: "Other", match: "BitTorrent", publisher: "BitTorrent Inc.", notes: "Often banned." },
    { name: "Steam", category: "Other", match: "Steam", publisher: "Valve", choco: "steam-client", winget: "Valve.Steam", notes: "Often banned on work PCs." },
    { name: "Epic Games Launcher", category: "Other", match: "Epic Games Launcher", publisher: "Epic Games", choco: "epicgameslauncher", notes: "Often banned on work PCs." },
    { name: "BlueStacks", category: "Other", match: "BlueStacks", choco: "bluestacks", notes: "Often banned." },
];
