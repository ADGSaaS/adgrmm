// backend/src/demo/demo.kb.ts
//
// Knowledge base content for the demo: how-to articles for the problems a help desk sees every week. Written in Markdown.
// Positions matter: the tickets in demo.desk.ts point at these articles by index.

export const KB_CATEGORIES = ["Email and Outlook", "Printing and scanning", "Networking and remote work", "Accounts and passwords", "Windows and devices", "Security"];

export type KbSeed = { title: string; cat: number; tags: string[]; visible: boolean; status: "published" | "draft"; views: number; helpful: number; unhelpful: number; edited?: boolean; body: string };

export const KB: KbSeed[] = [
    {
        title: "Outlook keeps asking for a password", cat: 0, tags: ["outlook", "microsoft-365", "password"], visible: true, status: "published", views: 412, helpful: 38, unhelpful: 3, edited: true,
        body: `## Symptoms
Outlook shows the sign-in box over and over, even after you type the right password. Sometimes it also says "Need password" at the bottom of the window.

## Quick fix
1. Close Outlook completely (check the system tray as well).
2. Open **Control Panel > Credential Manager > Windows Credentials**.
3. Remove every entry that starts with **MicrosoftOffice16**, **msteams** or **Outlook**.
4. Start Outlook again and sign in once. Tick "Remember my credentials" when asked.

## If it comes back
- Check that your computer's date and time are correct.
- Ask your administrator to check that multi-factor authentication is set up for your account.
- If you recently changed your password, sign out of every Microsoft app on your phone first, then sign in again.

## For technicians
Clear the cached token with \`cmdkey /list\` and remove stale targets. If the problem affects several people at once, look for a conditional access change before touching the PCs.`,
    },
    {
        title: "Add a shared mailbox to Outlook", cat: 0, tags: ["outlook", "shared-mailbox"], visible: true, status: "published", views: 268, helpful: 24, unhelpful: 1,
        body: `A shared mailbox usually appears in Outlook by itself within an hour of being granted. If it does not:

1. In Outlook choose **File > Account Settings > Account Settings**.
2. Select your email account and click **Change > More Settings > Advanced**.
3. Under **Open these additional mailboxes** click **Add** and type the name of the shared mailbox.
4. Click **OK**, then **Next** and **Finish**. Restart Outlook.

**Sending as the shared mailbox:** in a new message click **From** and choose the shared address. If **From** is not visible, open **Options > From**.

If the mailbox is missing from the list, ask your administrator to confirm you have *Full Access* and *Send As* permissions.`,
    },
    {
        title: "Printer prints blank pages or jobs get stuck", cat: 1, tags: ["printer", "spooler"], visible: true, status: "published", views: 531, helpful: 47, unhelpful: 5,
        body: `## Try this first
1. Turn the printer off and on.
2. Check paper, toner or ink and that no cover is open.
3. Print a test page from the printer's own menu. If that is blank, the problem is the printer (toner, drum), not the computer.

## Stuck jobs
1. Open **Settings > Printers & scanners**, choose the printer and **Open print queue**.
2. Select **Printer > Cancel All Documents**.
3. If the queue will not clear, restart the print spooler: press **Windows + R**, type \`services.msc\`, find **Print Spooler**, right-click **Restart**.

## Technicians
\`Restart-Service Spooler\` then clear \`C:\\Windows\\System32\\spool\\PRINTERS\`. If the printer is a network model, check its IP address is reserved on the router so it does not change.`,
    },
    {
        title: "Set up scan-to-email on a copier", cat: 1, tags: ["scanner", "copier", "smtp"], visible: false, status: "published", views: 96, helpful: 9, unhelpful: 0,
        body: `Internal checklist for copiers that scan to email.

- Use the customer's mail provider **SMTP relay** settings: server, port 587, STARTTLS, sender address on their domain.
- Many providers have retired basic authentication. Use an app-specific sign-in or an SMTP relay connector scoped to the customer's public IP address.
- Test with a scan to your own address, then to an external address.
- Record the copier's settings page and admin contact on the customer's asset record.

Common failure: "could not connect to server" after a provider change: the copier still points at the old server name.`,
    },
    {
        title: "Connect to the company VPN from home", cat: 2, tags: ["vpn", "remote-work"], visible: true, status: "published", views: 342, helpful: 29, unhelpful: 4,
        body: `1. Make sure your home internet works (open any website).
2. Open the **VPN client** from the Start menu.
3. Choose the connection named after your company and click **Connect**.
4. Enter your usual work email and password, then approve the prompt on your phone.
5. When it says **Connected**, open the file share or application you need.

## It will not connect
- Disconnect and reconnect to Wi-Fi, then try again.
- Restart your computer, then try again.
- If you see "certificate error" or "timed out" take a photo of the screen and send it to the help desk.

Never share your sign-in code with anyone, even if they say they are from IT.`,
    },
    {
        title: "Wi-Fi keeps dropping: what to check", cat: 2, tags: ["wifi", "network"], visible: true, status: "published", views: 207, helpful: 15, unhelpful: 6,
        body: `Work down the list; stop when it is fixed.

1. Is it only you or everyone? Ask a colleague.
2. Move closer to the access point and check the signal bars.
3. **Forget** the network and join it again.
4. Update the Wi-Fi driver (the help desk can do this remotely).
5. Check the Wi-Fi adapter's power setting: *Device Manager > Network adapters > Properties > Power Management* and untick "Allow the computer to turn off this device to save power".

For technicians: check channel overlap with a Wi-Fi scan, firmware version on the access point and whether the problem happens in the same place.`,
    },
    {
        title: "Reset a forgotten Windows or Microsoft 365 password", cat: 3, tags: ["password", "account"], visible: true, status: "published", views: 689, helpful: 61, unhelpful: 2,
        body: `## Self-service
1. On the sign-in page choose **Forgot my password** (Microsoft 365) or **I forgot my password** (Windows).
2. Verify your identity with the phone number or authenticator app you registered.
3. Choose a new password: at least 14 characters, not used before.

## If self-service is not set up
Call or email the help desk. We will verify who you are before resetting: we will never ask for your current password.

## For technicians
Always verify identity with a known contact or the manager. After a reset, force a change at next sign-in and revoke active sessions for a suspected compromised account.`,
    },
    {
        title: "New starter checklist", cat: 3, tags: ["onboarding", "checklist"], visible: false, status: "published", views: 154, helpful: 12, unhelpful: 0, edited: true,
        body: `## Before day one
- [ ] Account created in the directory with the standard groups
- [ ] Microsoft 365 licence assigned and mailbox created
- [ ] Multi-factor authentication registered
- [ ] Laptop built with the standard image and encrypted
- [ ] Shared drives and printers added
- [ ] Phone extension and voicemail

## Day one
- [ ] Hand over equipment and the welcome sheet
- [ ] Walk through sign-in, email, and how to ask for help
- [ ] Confirm the manager received the checklist

## After a week
- [ ] Ask the new starter if anything is missing
- [ ] Close the ticket`,
    },
    {
        title: "Windows says restart is required: what to do", cat: 4, tags: ["windows-update", "restart"], visible: true, status: "published", views: 301, helpful: 22, unhelpful: 2,
        body: `Windows needs to restart to finish installing updates. Until you do, your computer may be less protected and updates will keep nagging.

- Save your work and choose **Restart now** when it suits you.
- Updates installed at restart can take 10 to 30 minutes: leave the computer plugged in.
- If you postpone it several days in a row, we will ask you to restart.

If the computer will not finish restarting after an hour, hold the power button for 10 seconds and start it again, then contact the help desk.`,
    },
    {
        title: "How to spot a phishing email", cat: 5, tags: ["phishing", "security", "awareness"], visible: true, status: "published", views: 478, helpful: 51, unhelpful: 1,
        body: `## Warning signs
- It asks you to act **urgently** or threatens to close an account.
- The sender's address does not match the company (look at the part after the @).
- A link shows one address but hovers to another.
- It asks for passwords, payment details or gift cards.
- Unexpected attachments, especially .zip, .html or .exe files.

## What to do
1. **Do not** click links or open attachments.
2. Forward the message to the help desk as an attachment.
3. Delete it.

## If you clicked
Tell us straight away. Do not be embarrassed: speed matters more than anything. We will reset your password and check for damage.`,
    },
    {
        title: "Responding to a malware detection on an endpoint", cat: 5, tags: ["malware", "incident", "internal"], visible: false, status: "draft", views: 33, helpful: 0, unhelpful: 0,
        body: `Internal runbook, draft.

1. Look at the alert: threat name, file path, whether it was quarantined or is still active.
2. If the threat is **active**, isolate the machine (disconnect from the network) before doing anything else.
3. Run a full offline scan from the console.
4. Check how it arrived: downloads, USB drives, email.
5. Check other machines for the same file name or hash.
6. Reset the user's passwords if credentials may have been exposed.
7. Document in the ticket: what was found, what was removed, what changed to stop it happening again.

Escalate to the security lead for ransomware indicators or any data copied off the network.`,
    },
    {
        title: "Disk almost full: safe cleanup steps", cat: 4, tags: ["disk", "storage", "cleanup"], visible: true, status: "published", views: 325, helpful: 28, unhelpful: 3,
        body: `## Free space safely
1. Empty the **Recycle Bin**.
2. Open **Settings > System > Storage** and turn on **Storage Sense**.
3. Choose **Temporary files** and tick *Windows Update Cleanup*, *Delivery Optimization Files* and *Temporary files*. Do not delete Downloads unless you checked it.
4. Uninstall programs you no longer use.

## Still full?
Move large files (videos, old backups, photo libraries) to the shared drive or an external disk. The help desk can show you which folders are taking the most room.

## Technicians
Use a folder size tool for the top level, check \`C:\\Windows\\Temp\`, shadow copies, old user profiles and application caches. Plan a disk upgrade when free space is under 10% twice in a month.`,
    },
];
