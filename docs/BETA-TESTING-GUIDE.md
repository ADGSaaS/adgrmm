# ADG RMM Beta Testing Guide

This guide is for testers working on a **fresh installation** of ADG RMM that they set up themselves. It starts with installing the server, then installing the agent on test computers, then has one test section for every feature that is built but not yet confirmed on real machines. The sections use the numbers from the [roadmap](roadmap/ROADMAP.md).

Do the setup in Parts A to D first. Every later section assumes that setup is done.

## What you need

| Item | Needed for |
|---|---|
| A server (a virtual machine is fine): Ubuntu 22.04, Ubuntu 24.04 or Debian 12, 64-bit, 2 GB memory or more, 6 GB free disk | Part A |
| A domain name pointing at that server, for example `rmm.example.com`, with ports 80 and 443 reachable from the internet (or your own reverse proxy) | Part A |
| One or more Windows 10 or 11 computers (a virtual machine is fine) | Part C, most tests |
| One Linux virtual machine (Ubuntu or Debian) | Part C, the Linux tests |
| An email mailbox you can use for SMTP (optional but several tests need it) | Part D |
| A Slack or Teams workspace and a Microsoft 365 test tenant (optional) | Only the sections that say so |

Take a **snapshot** of each virtual machine before you start. If something goes wrong you can go back to a clean state and test again.

If a section needs something you don't have, mark it **Skipped** and say why.

---

## Part A: Install the server

1. Sign in to the server with a user that can use `sudo`.
2. Make sure the domain name already points at the server's address (check with `nslookup rmm.example.com` from another computer).
3. Run the installer. If the project's release page is private, the development team will give you a token first: run `export GITHUB_TOKEN=<token>` and use `sudo -E bash` instead of `sudo bash` below.

```bash
curl -fsSL https://github.com/adgrmm/adgrmm/releases/latest/download/install.sh | sudo bash
```

4. Answer the questions. If you are unsure, take the first choice listed:
   1. **How to run:** Docker or native. Pick one, and write down which one you picked. Run the whole test again later with the other if you can.
   2. **Web address and HTTPS:** choose the built-in HTTPS (Let's Encrypt) if the server is reachable from the internet. Choose "I already have a reverse proxy" if you use something like Nginx Proxy Manager (see step 7). Choose self-signed only for a quick look: the sign-in cookie needs HTTPS.
   3. **Database:** let it install PostgreSQL 16 for you.
   4. **Company name and administrator:** a company name, your name, an email address and a password. Write these down: this is your first sign-in.
   5. **Email sending (SMTP):** optional. If you give mailbox details, it sends a test email. Note whether the test email arrived.
   6. **Customer portal:** optional. Say yes if you want to test Phase 5. You need a second name such as `portal.example.com`.
   7. **A first customer and site:** say yes and give names such as "Test Customer" and "Main Office". It prints a one-line command to install the agent. Copy it somewhere safe.
5. Wait for it to finish. It downloads the release, checks its checksum, installs and starts everything.
6. Check that everything is healthy:

```bash
sudo bash /opt/adgrmm/install.sh status
```

7. If you use your own reverse proxy: add a host for your domain that forwards to `http://<server address>:8080`, turn **Websockets Support** on, and request a certificate. Add a second host with the same target for the portal name.
8. Open `https://<your domain>` in a browser and sign in with the administrator you created.

**Expected:** the installer finishes without an error, `status` reports everything healthy, and you can sign in.

**Report if:** the installer stops with an error (copy the last 20 lines), a step is unclear, `status` shows anything unhealthy, the certificate is not issued, or the sign-in fails. If it stops part way, run the same command again: it keeps your earlier answers. Send the support bundle with your report:

```bash
sudo bash /opt/adgrmm/install.sh status --logs
```

### Back up the keys

Copy the folder `/opt/adgrmm/secrets/` to somewhere safe outside the server. It holds the data encryption key and the job signing key. Without them, stored passwords and encrypted backups cannot be read and every agent has to be reinstalled.

---

## Part B: First set-up in the console

1. Sign in at `https://<your domain>`.
2. Open **Customers**. If you did not create a first customer in the installer, choose **New** then **New customer** and give it a name, then **New** then **New site** and give it a name.
3. In the top bar open **Administration** and look through the tabs. Note anything that errors or looks unfinished. Some tabs are hidden on purpose until they work.
4. Create a second person under Administration (Users) with the **Operator** role, and sign in as them in a private browser window. This second account is useful for the access tests.

**Expected:** the customer and site show in the Customers list, and the second person can sign in.

**Report if:** anything fails to save, or a page shows an error.

---

## Part C: Install the agent on a test computer

An agent is the small program that connects a computer to ADG RMM. Every device test needs at least one.

### Make an install key

1. Open **Customers**, then choose **Reusable installer**.
2. Choose the **Client** and the **Site** the computer belongs to.
3. Choose how long the key lasts (7 days is fine for testing) and give it an optional name.
4. Choose **Create Enrollment Key**.
5. The dialog now shows **Install on a device**. Choose **Windows** or **Linux** to switch the command, then choose **Copy command**.

### Windows

1. On the test computer, open **PowerShell as Administrator**.
2. Paste the command and press Enter.
3. Wait for it to finish. The computer should appear in the console under **Devices** within a minute or two, and shows as online.
4. Note: new Windows installs can be blocked by Microsoft Defender at the moment (a known false positive, roadmap 0.12). If Defender blocks the file, write down the exact message and the time, and tell the development team. For testing, you can add the install folder as a Defender exclusion, but say in your report that you did.
5. On the device page, check the **Overview** tab shows the computer's name, operating system and the agent version. Write down the agent version: you need it for every report.
6. Look next to the clock for the ADG RMM tray icon. It is needed for the tray tests (5.5).

### Linux

1. On the Linux virtual machine, open a terminal with `sudo` access.
2. In the install dialog choose **Linux** and **Copy command**, then paste it into the terminal and run it.
3. The machine should appear in the console and show online within a minute or two.
4. Check the service is running:

```bash
systemctl status adgrmm-agent
```

### Group Policy (optional)

Tick **For Group Policy or other start-up scripts** in the install dialog and follow the text it shows, if you have a Windows domain to test with.

### Confirm the device works

For each new device:

1. Open it from **Devices**.
2. Check it shows as online and the Overview is filled in (name, system, memory, disk).
3. Wait 5 minutes. Check the graphs begin to fill and no alert is open for no reason.
4. Restart the computer. Check the device goes offline and comes back online by itself within a few minutes.

**Report if:** the install command fails, the device never appears, shows the wrong name or system, or does not come back after a restart.

### Remove an agent (to test installing again)

Ask the development team for the uninstall command for your agent version. Then install again on a clean snapshot to check a second install works.

---

## Part D: Optional services some tests need

### Email

1. Open **Administration** and the email (SMTP) settings.
2. Enter your mailbox details and send a test email to yourself.
3. Check it arrives.

### Support mailbox (email to ticket)

Needed for 3.2. Under Administration, connect a mailbox for support with Microsoft 365 sign-in or IMAP, and check the settings say it is connected.

### Customer portal

Needed for Phase 5. Check the portal address under Administration, **Client Portal**. If you changed the address after installing, run this on the server so the built-in HTTPS knows the name:

```bash
sudo bash /opt/adgrmm/install.sh reconfigure
```

### Notification channels

Needed for 1.46, 9.2 and 9.3. Under Alerts, create a notification channel of type webhook and paste a Slack incoming-webhook address or a Teams workflow address.

---

## Part E: Upgrade and uninstall (test these last)

1. **Upgrade.** Take a snapshot first. Run:

```bash
sudo bash /opt/adgrmm/install.sh upgrade
```

   **Expected:** it backs up the database, installs the newest release, starts it, and your data and devices are still there. If it fails it rolls back by itself.
2. **Uninstall.** On a spare snapshot run `sudo bash /opt/adgrmm/install.sh uninstall`, and choose whether to keep your data. **Expected:** it asks the question and does what you chose.
3. **Reinstall** on the same server after uninstalling and check a clean install still works (roadmap 10.17).

---

## How to report

For each section, note one of: **Pass**, **Fail** or **Skipped**. For a Fail, send:

1. The section number and name.
2. The step you were on and what you expected.
3. What actually happened, with a screenshot.
4. The device name, the agent version (device page, Overview), whether the server runs on Docker or native, and the time it happened.

A section's **Report if** line says what counts as a failure. Copy one line per section into your own notes as you go: `number | Pass/Fail/Skipped | notes`.

---

# Feature tests

Do Parts A to D first. Each section lists what it needs beyond that.

### 0.9 Report why an update failed after the agent accepted it
Needs: A developer. A real failed update has to be forced on a Windows PC, and only the newest agent build reports it (older agents say nothing). A tester can only check the places where a failure would appear.
Steps:
1. Sign in to https://console.example.com as an Owner.
2. Open Administration > Infrastructure > Agents and read the "Agent updates" box. Note whether "Offer new agent versions to devices automatically" is on.
3. In the left menu open Automation > Scripts and automation, then the "Failures" tab.
4. Look for any row whose type is "Agent update".
5. If a developer has forced a failed update on a test PC, wait for that PC's next check-in (a few minutes), then reload the Failures tab and the Agents page.
Expected result: A failed update shows as an "Agent update" row on the Failures tab with a plain reason (for example rolled back, could not roll back, failed verification). The row disappears once that PC runs the new version or newer. With no failed updates, the Failures tab simply shows nothing for "Agent update".
Report if: An update clearly failed on a PC (it still runs the old version and keeps being offered the update) but no "Agent update" row appears; the reason text is blank or says only "unknown"; the row stays after the PC has the new version.

### 0.12 Microsoft false positive review
Needs: A clean Windows PC that has never had the agent, with Microsoft Defender on and up to date (run Windows Security > Virus & threat protection > Protection updates > Check for updates first). Permission to install software.
Steps:
1. On that PC, sign in to the console in a browser, go to Administration > Infrastructure > Install keys and make an install key for a test customer (use the install steps shown there).
2. Download the Windows agent installer from the link the page gives.
3. Before running it, watch for any browser or Windows warning ("not commonly downloaded", "threat found", file removed). Write down the exact words.
4. Run the installer as administrator.
5. Open Windows Security > Virus & threat protection > Protection history and check for any entry about the installer or the agent.
6. Open the console, Devices, and confirm the PC appears.
Expected result: The download and install complete with no Defender threat detection. Protection history has no entry for the agent or the capture helper. (A SmartScreen "unknown publisher" notice is expected until the file is signed and is not a failure.)
Report if: Defender blocks, quarantines or deletes the file, or Protection history names it as a threat. Send a screenshot, the exact threat name, the date of your Defender signatures, and the time. A developer will then collect diagnostic data with mpcmdrun.exe -GetFiles.

### 1.1 Alert engine: open, acknowledge, silence and resolve

Needs: A Windows or Linux PC with the agent installed and online; an account that can see and manage alerts.
Steps:
1. On the test PC, fill a disk or push CPU to near 100% (for example run a stress tool for 10 minutes). If you cannot, go to Alerts > Checks, click New check, choose a type that will fail (for example a Service name that is stopped, or a Process name that is not running), and set Runs on to the test PC.
2. Open Alerts in the console. Wait until the next check run (as long as the check's "Every (minutes)" value).
3. Look at the Open tab (the tabs are Open, Acknowledged, Silenced, Resolved). Confirm a new alert for the test PC appears with the right severity (Critical or Warning).
4. Tick the alert and click Acknowledge. Confirm it moves to the Acknowledged tab.
5. Make a second alert fire (or wait for another) and use Silence. Pick 1 hour from the list (1 hour, 4 hours, 1 day, 1 week). Confirm it moves to Silenced and does not come back to Open.
6. Fix the problem on the PC (free disk space, stop the stress tool, start the service). Wait for the next check run.
7. Confirm the alert moves to Resolved by itself. Use the Refresh button if needed.
Expected result: A real device problem produces an alert, and acknowledge, silence and automatic resolve all move it to the right tab. This is the first time it is seen on a real device, so the firing step is the focus.
Report if: No alert appears after two check intervals; the alert shows the wrong device or severity; acknowledge or silence does nothing or the alert returns to Open; the alert never resolves after the problem is fixed; or the same problem makes duplicate open alerts.

### 1.2 Offline device alerts

Needs: A test PC with the agent that you can switch off or disconnect from the network; access to Alerts.
Steps:
1. Go to Alerts, click Notifications and settings. Under Behaviour, note the value of "Call a device offline after" (15 minutes by default). For a faster test set it to 5 and click away to save.
2. Confirm the test PC shows Online on the device list.
3. Power the PC off (or unplug the network). Write down the time.
4. Wait the set number of minutes plus 2.
5. Open Alerts and look in the Open tab for an offline alert for that PC.
6. Turn the PC back on. Wait up to 5 minutes.
7. Check that the offline alert moves to Resolved.
8. Put the setting back to its original value.
Expected result: An offline alert opens after roughly the set time (not much earlier, not hours later) and resolves after the device returns.
Report if: No alert after the set time plus a few minutes; the alert opens much earlier than the set time (for example after a brief reboot); the alert stays Open after the device is back online; or an offline alert appears for a device that never went offline.

### 1.4 Alert to ticket: open and close tickets automatically

Needs: A test PC with the agent; an account that can change alert settings and view Tickets.
Steps:
1. Go to Alerts > Notifications and settings. Under Behaviour, switch on "Open a ticket for new alerts" and choose a severity in "For".
2. Switch on "Resolve the ticket when the alert clears, if nobody has started on it".
3. Cause a new alert (see test 1.1) on the test PC.
4. Open Tickets and confirm a ticket for that alert exists. Open it and check the text mentions the device and the problem.
5. Do not touch the ticket. Fix the problem on the PC and wait for the alert to resolve.
6. Reopen the ticket and confirm it is now closed/resolved.
7. Repeat with a new alert, but this time open the ticket, add a reply or assign it to yourself before fixing the problem. After the alert resolves, confirm the ticket stays open.
8. Switch the two settings off, cause another alert and confirm no ticket is made.
Expected result: A ticket opens for a new alert at or above the chosen severity; it closes by itself only when nobody had started on it; with the settings off no tickets appear.
Report if: No ticket opens; two tickets open for one alert; the ticket closes even though you had replied or assigned it; the ticket does not close when untouched; or tickets appear with the setting off.

### 1.5 Check management screens

Needs: A test PC with the agent (Windows or Linux); an account that can manage checks. Agent 1.3.5 or newer.
Steps:
1. Go to Alerts and click Checks. Read the note that says every agent already runs built-in disk, CPU and memory checks.
2. Click New check. Fill in Name (for example "Test process"), Type (pick a process or service check), the Process name or Service name, "Every (minutes)" (for example 5), "Severity when it fails".
3. Under Runs on, add the test PC as a target (use the Add button), leave "Turned on" ticked and click Save.
4. Confirm the check appears in the list. Click the Edit (pencil) button, change the Name and Save. Confirm the change shows.
5. On the PC make the check fail (for example choose a process name that is not running). Wait one interval and confirm an alert shows in Alerts > Open.
6. Open the test device page > Checks & Alerts tab and confirm your custom check is listed beside the built-in disk, CPU and memory checks.
7. Back in Alerts > Checks, click Delete on your check and confirm. Confirm it disappears and the device stops running it after its next check-in.
Expected result: Custom checks can be created, edited, assigned and deleted from Alerts, and they run in addition to the built-in checks.
Report if: Save gives an error; the check never runs on the device; built-in checks disappear when you add a custom one; edits do not stick; or deleting the check leaves it still firing.

### 1.7 Script library: save, share, parameters, history

Needs: At least one online device (Windows with PowerShell is easiest); an account that can run scripts.
Steps:
1. Go to Automation. The page tabs are Scripts, Schedules, History, Failures and Bulk actions. Open the Scripts tab.
2. Click New script. Give it a name, choose a shell, and write a simple script that prints a parameter, for example `Write-Output "Hello $Name"` on PowerShell.
3. In the Parameters section click the add button, enter the parameter name `Name`, tick Required if you like, and give a default value. Save the script.
4. Confirm the script appears in the library. Edit it again and confirm the parameter is still there.
5. Click Run on the script. In the Run dialog (titled "Run <script name>") choose one device, enter a value for the parameter, and click Run.
6. Open the History tab. Confirm the run is listed with the device, the result and the output text containing your value.
7. Click Run again, but pick several devices (if you have more than one) and confirm each gets a history entry.
8. Try to run with the required parameter left empty and confirm it is refused with a clear message.
Expected result: Scripts save with parameters, run on one or many devices and every run appears in History with its output.
Report if: Parameters are lost on save; the script runs without the parameter value; History shows no entry or empty output; a run on several devices only reaches some of them; or you see a raw error code instead of a message.

### 1.8 Scheduled and bulk scripts

Needs: At least one online device; a saved script (see 1.7).
Steps:
1. Go to Automation > Schedules and click New schedule.
2. Pick your script, the device(s) to run on, and set a repeat by interval (for example every 5 minutes; units are minutes, hours, days or weeks). Save.
3. Wait for three intervals. Open Automation > History and confirm there are three runs about 5 minutes apart.
4. Back in Schedules, pause or delete the schedule and confirm that no further runs appear.
5. Open Automation > Bulk actions and start (or open) a bulk run on several devices. Confirm you can open the batch and see per-device results.
6. Note: there are no cron-style times (for example "every Monday 02:00"); only an interval. Do not report that as a bug.
Expected result: The script runs repeatedly at the chosen interval until paused or deleted; bulk runs show a result for each device.
Report if: A scheduled run is missed or runs much more often than set; a run happens after the schedule was removed; a device in a bulk batch has no result; or the schedule list shows the wrong next time.

### 1.9 Maintenance windows

Needs: A test PC with the agent in the pilot or normal ring; account that can edit policies; ability to switch the PC off or fail a check on it at will.
Steps:
1. Go to Policies > Policies and create or open a policy that applies to the test PC (use New policy and pick Global, Customer, Site or Tag; assign it to the test PC).
2. In the policy editor open the Maintenance windows section. Click Add a window. Fill Name, tick the days, set Starts and Ends so that the window is open right now (for example 5 minutes ago to 30 minutes from now, in 24-hour form like 14:00) and choose the Time zone. Make sure "Hold alerts back during a window" is on. Save the policy.
3. Open the test device page > Policies tab. Confirm it says the device is in a maintenance window and shows the policy and window name. Then change the window to a time later today and confirm the tab shows "next opens" with the right time.
4. Set the window to be open now again. Cause a check to fail or turn the PC off long enough to count as offline (see 1.2).
5. Confirm no offline or check alert is raised in Alerts while the window is open.
6. Let the window end (or edit it to end) while the problem still exists. Confirm that the alert is then raised, shortly after the window closes.
7. Try saving a window with no name, no day, or a time like 25:00 and confirm the editor says "Required", "Choose a day" or "Like 02:00".
Expected result: Alerts for a device in an open window are held back; if the problem is still present after the window closes, the alert opens then. The device's Policies tab shows the window status and next opening.
Report if: An alert fires during the open window; no alert appears after the window closes with the problem still there; the next opening time is wrong for the chosen time zone; or the device Policies tab says the wrong thing about the window.

### 1.10 Patch management: approve, schedule, report

Needs: A Windows PC with the agent and some pending updates (a fresh, not fully updated machine is best); a Maintenance window set up (see 1.9); permission to edit policies. Use a test PC you can restart.
Steps:
1. Open the test device > Patch tab (Patch Management). Click Scan Now and wait until the update list fills. Note which updates are listed and their severities.
2. Go to Policies and open a policy that applies to the PC. Open the Patching section.
3. Set "Install updates automatically" to "Critical and important updates (security updates on Linux)". Set "When to install" to "Only in a maintenance window". Set "Restart when an update needs it" to "In a maintenance window". Save.
4. Make sure a maintenance window is open now or opens within the hour (Maintenance windows section of the same policy).
5. Wait for the next daily scan, or click Scan Now on the Patch tab. Watch the Patch tab: critical and important updates should begin installing only while the window is open.
6. After install, if a restart is needed, confirm the PC restarts (the person at the device gets a two-minute warning) only inside the window.
7. Open the device Policies tab or Patch history and confirm what the policy did is listed (for example "installed" and "restarted") and that the same install or restart is not repeated within 4 hours (install) or 6 hours (restart).
8. Repeat with "When to install" set to "Any time" and confirm installs start without a window. Set the restart option to "Never, restart by hand" and confirm no restart happens.
9. Not built yet (do not report): choosing single updates, deferral rings, and a patch compliance report per customer.
Expected result: Updates install automatically according to the policy rules, only inside a window if set, restarts follow their own rule, and the device shows what the policy did without repeating actions within the cooldown.
Report if: Updates install outside the window when "Only in a maintenance window" is chosen; a restart happens at a bad time or without warning; the same update is tried again and again; the device page shows nothing about what the policy did; or updates are never installed even with the window open.

### 1.11 Third-party software patching

Needs: A Windows PC with agent 1.3.34 or newer and winget or Chocolatey; at least one installed program that has a newer version available (install an old version of something small, for example an old 7-Zip, on purpose).
Steps:
1. Open the test device > Software tab, find the outdated programs panel (Outdated programs). Click the button that looks for programs with a newer version ("Look for programs with a newer version"). Wait until the list fills.
2. Confirm your deliberately old program is listed with current and newer versions, and which tool (winget or Chocolatey) will update it.
3. Click Update on that single program. Confirm status goes from Waiting to Updating and then it disappears or shows the new version. Check on the PC that the program version really changed.
4. Go to Policies > Outdated apps and add a program to the allowed list (Auto allowed) and another to Never update.
5. Go to the policy editor > Software section or Patching section. Set "Update other programs automatically" to "Only programs on the allowed list", "When to update programs" to "Any time", and the scan interval (hours). Save.
6. Wait for the next scan and confirm the allowed program updates on its own and the Never update one does not.
7. Go to Reports and open the Outdated software report. Confirm the PC and its outdated programs appear.
8. Try Update all on the device (if shown) and confirm results are listed afterwards per program.
Expected result: Outdated programs are found daily, can be updated singly or all together, the allow and never lists are respected, the Outdated software report matches, and results are checked after the update.
Report if: The scan finds nothing when you know a program is old; an update reports success but the version did not change (or the reverse); a Never-update program is updated; the report disagrees with the device; or this fails on specific machines (note the Windows version and whether winget or Chocolatey was present).

### 1.12 Software install and removal from the dashboard

Needs: A Windows PC with agent 1.3.33 or newer; ideally two or three different PCs, since it has not been tried across a fleet; permission to manage software.
Steps:
1. Open the device > Software tab. Click Install software.
2. In the dialog titled "Install software" pick something from the software library starter set (for example a small utility) and choose the install method offered (Chocolatey, direct installer or winget). Confirm.
3. Watch for the "Install queued" message and then a finished or failed message. Verify on the PC that the program is now installed.
4. Try an install for one signed-in user (the per-user choice using winget, named after the signed-in user) while someone is signed in. Confirm the program appears for that user only.
5. On the program row open the menu and choose Uninstall (for example "Uninstall with Chocolatey..."). Confirm in the dialog. Check on the PC that it is gone.
6. Open the install log (the software install log on the Software tab) and confirm every install and removal is listed with the person, time and result.
7. Repeat steps 2 and 5 on a second and third PC, including one with an older Windows version or no Chocolatey installed, and note any differences.
Expected result: Programs install and uninstall as requested, per-user installs work, and the log lists each action with its result.
Report if: Install says success but the program is missing; Uninstall removes the wrong thing or nothing; the log misses an action; the install hangs with no result after 15 minutes; or it fails only on certain machines (say which).

### 1.15 Hardware and performance history

Needs: Any online device that has been running a few days (the longer the better; a brand-new device has little to draw).
Steps:
1. Open the device page. On the Overview tab find the Performance history section.
2. Look at the CPU busy and Memory in use graphs. Switch the Period between 24 hours, 7 days and 30 days and confirm each re-draws with a sensible time axis.
3. Find the Availability and Disk free history chart. Switch the Days choice up to a long period (for example 90, 365 or the maximum, up to 800 days).
4. Hover over points and confirm values are shown and are plausible (for example disk free is the lowest each day).
5. Open a brand-new device (installed today) and confirm the graphs say why there is nothing to draw yet, instead of a blank box.
6. Compare the current CPU use to Task Manager (Windows) or top (Linux) while loading the CPU briefly, then check the 24-hour graph shows a bump.
Expected result: Three periods of CPU and memory graphs plus a long disk-free and availability history, with a clear message when data is missing.
Report if: A graph is empty on a device with days of history; the time axis is wrong; switching period does nothing; there is no explanation for an empty chart; or values are clearly wrong (for example 0% for a busy machine).

### 1.16 Windows service, process and event log tools

Needs: One Windows PC and one Linux machine with the agent; an account that has the permission for these tools (ask your admin if the tab or its buttons are missing).
Steps:
1. Open the Windows device > Services / Processes / Event log tab. The sections are Services, Processes and Event log.
2. In Services, search for a harmless service (for example Print Spooler). Click Stop, confirm the status changes to stopped on the list (and on the PC in services.msc), then Start. Try Restart. Change the start type (for example to Manual and back).
3. In Processes, start Notepad on the PC, find notepad.exe in the list and use the end option. Confirm it closes on the PC and the console says so.
4. In Event log, choose a log (for example System), apply a filter (level, time range or text) and confirm only matching events are shown. Use the CSV download and open the file in a spreadsheet to confirm the rows match the screen.
5. Repeat the three sections on the Linux device (services are systemd units, event log is the journal).
6. Open Admin > Audit logs and confirm each stop, start, restart, end process and event log read was recorded with your name.
7. If you have a user without the permission, sign in as them and confirm they cannot use the tab.
Expected result: Services, processes and event log work on both Windows and Linux, changes take effect on the device, and every action is audited.
Report if: A button does nothing or shows an error; the change is not reflected on the device; the event log or CSV is empty when events exist; the Linux tab is missing; an action is not in the audit log; or a user without the permission can still act.

### 1.20 Network discovery and SNMP monitoring

Needs: A site with at least one agent PC online and a LAN containing other equipment; ideally one SNMP-capable device (printer, switch or router) and its SNMP v1/v2c community string.
Steps:
1. Go to Network discovery in the console. Pick the customer and site (for example "All online devices of this site" for the scanning agent) and click Start scan. Wait until hosts appear.
2. Confirm the host list shows IP, name, "Looks like" guess, Managed or Not managed and open ports. Use the Search the hosts box and the Show filter.
3. Under Scheduled scans create a schedule (Save schedule), then Pause and Resume it.
4. Pick a Not managed host and click Add as asset (only if the built-in asset manager is enabled).
5. Go to the SNMP page. Click Monitor a network device, enter the address and community string and click Start monitoring.
6. After a poll, confirm the device shows as Answering, with Ports and Supplies (for example toner levels) where the device supports them. Test Pause monitoring and Resume monitoring. Test with a wrong community string and confirm it shows Not answering.
7. Open the History view for the device and confirm earlier status is listed.
8. Do not report as bugs (not built): SNMP v3, traps, port and page-count graphs over time, port-down alerts.
Expected result: Scans find the devices on the network, schedules run, and SNMP devices report ports and supplies with an up or down state.
Report if: The scan finds far fewer hosts than you know exist; hosts are mislabelled; monitoring a reachable SNMP device stays "Not polled yet" or "Not answering"; port or supply values are wrong; or Pause/Resume does not stick.

### 1.21b Automatic copy and paste between the technician and the device
Needs: A Windows PC with agent 1.3.10 or newer, a browser on another computer, a text editor on both, and ideally a password manager (for example Bitwarden or KeePass) on the Windows PC.
Steps:
1. In the console open the device and start the Remote Console (remote desktop). Click inside the picture so it has focus.
2. On your own computer copy some text, click in the remote Notepad window and paste with Ctrl+V. Check the text appears.
3. On the remote PC select and copy text in Notepad (Ctrl+C), then paste into a text editor on your own computer. Check it arrives without any extra step.
4. Copy a long text, text with accents, and an emoji, and check each arrives intact.
5. Copy a password from the password manager on the remote PC (the manager clears or hides its clipboard) and check it does NOT arrive on your computer.
6. Try the browser's clipboard permission prompt: if asked, allow and repeat step 3.
Expected result: Text copied on one side pastes on the other automatically; passwords from managers that ask to be excluded are not sent.
Report if: text does not arrive, arrives only after pressing a button, arrives garbled, or a password-manager copy shows up on your computer. Say which browser you used.

### 1.21c Faster first picture
Needs: The test VM (or a PC) with agent 1.3.10 or newer, a stopwatch or a phone with a stopwatch, and a browser.
Steps:
1. Make sure no remote session to the device is open.
2. In the console open the device and press the button to start the Remote Console. Start the stopwatch the moment you click.
3. Stop it when the first picture of the remote screen appears. Write down the seconds.
4. Close the session and repeat five times, first on a machine just started, then on one already used.
5. Send the five times with the device type (VM or real PC), the browser and whether you are on the same network.
Expected result: The first picture appears within a few seconds each time; the measured numbers are what is being collected.
Report if: it takes more than 10 seconds, takes noticeably longer than earlier versions, or sometimes never appears.

### 1.22b Relay bandwidth while dragging
Needs: A technician on a normal home or office network, a Windows device online, an Administrator login. Optionally a second network that blocks direct connections (a strict office or a phone hotspot) to force the relay.
Steps:
1. Start a Remote Console session to a device and drag a window around the remote screen continuously for two minutes. Then close the session.
2. Repeat on the second network if you have one, and repeat a few times over several days so there are real sessions.
3. Open Administration, then the System tab, and find the card that shows the share of sessions through the relay and the GB used over 30 days.
4. Write down the percentage of sessions using the relay and the GB used.
Expected result: Most sessions go direct (relay share low); relay GB stays small; the numbers update after each session. The page must be on the newest front end.
Report if: the relay card is missing or empty after several sessions, shows a high percentage on a normal network, or the GB figure looks far above what the sessions used (roughly 3.6 GB per hour of continuous dragging when relayed).

### 1.22d Screen size picker
Needs: A real Windows PC or VM whose display offers two or more resolutions (a VM with a VirtIO or QXL display driver, or a physical PC), agent 1.3.17 or newer.
Steps:
1. Start the Remote Console on the device.
2. Look in the console header for a Screen size dropdown. It only shows when the device offers two or more sizes.
3. Open the dropdown, choose a smaller size, and watch the remote screen change.
4. Choose another size, then close the session and open a new one. Check the same size is remembered for this device in this browser.
5. Try a device with a single resolution (the Microsoft Basic Display Adapter VM) and check the dropdown is hidden.
Expected result: The dropdown lists real supported sizes, changes the main display, and remembers the choice per device.
Report if: the dropdown never appears on a multi-resolution machine, a size change fails or leaves a black screen, the original size cannot be restored, or the choice is forgotten. Include the PC's graphics adapter name.

### 1.23 Hardware video encoding (H.264)
Needs: A Windows PC with a real graphics adapter (NVIDIA or Intel is especially wanted, AMD already tried), agent 1.3.35 or newer, Chrome. Safari or Firefox for the extra browser check. A developer or administrator who can set the customer's video setting.
Steps:
1. Ask an administrator to set the test customer's video encoding to Auto (Customers, open the customer, the video encoding setting). Never choose H.264 directly (it also allows a worse software encoder).
2. Start a Remote Console to a device of that customer and use it for five minutes (drag windows, play a video).
3. Judge the picture: smoothness while dragging, sharpness of text, delay when typing.
4. If you can, open the Windows Task Manager on the device and note the agent's CPU use while you drag a window.
5. Repeat in Firefox and in Safari (if available), and with the agent running as a service with nobody signed in at the sign-in screen.
6. Write down the PC's graphics adapter(s) and whether the session looked better or worse than normal.
Expected result: Auto uses the hardware encoder only if its self-test passes, otherwise quietly falls back to normal (VP8). No black screen or freezes.
Report if: the picture is black, frozen, blocky or noticeably delayed, a session fails to start, or the picture is worse than before. Include graphics adapter and browser.

### 1.26 Session recording
Needs: Two Windows devices online, an Administrator login, and a second login with fewer rights (to test permissions).
Steps:
1. As Administrator turn recording on for the test customer (customer settings, or in a policy: the setting to record Remote Console sessions).
2. Start a Remote Console session to a device of that customer, do some visible things for one minute (open Notepad, type text, move windows), then close the session.
3. Open Devices > Session recordings. Check the new recording is in the list with a status (Recording now, Complete, Cut short or Failed), the right device and a length.
4. Press the play icon and watch it in the browser. Check what you did is visible.
5. Press the download icon and play the file on your computer.
6. Use the filters and the settings at the top: change the retention days, maximum recording size and quota and save.
7. Delete a recording (trash icon).
8. Sign in as the lower-rights user and check they cannot see or play recordings unless given the right.
9. Start a session with recording off and check no recording appears.
Expected result: Sessions are recorded when turned on, play back correctly, download, honour retention, and need their own permission.
Report if: a recorded session is missing, status stays Recording now, a recording is shorter than the session or will not play, the download does not play, old recordings are not removed after the retention period, or a user without the right can open them.

### 1.30 Policies

Needs: At least two test PCs (ideally in different customers or sites) with agents; an account with policies.read and policies.write.
Steps:
1. Go to Policies. The views are Policies, Templates, Software, Outdated apps, Tags, Baseline, Check profiles and History. Stay on Policies.
2. Click the New policy menu and choose Global. Fill in Details (name), set Alerting (for example minutes offline before an alert), set Business hours, and set a Remote access notice. Save.
3. Create a second policy of kind Customer assigned to one customer, with different alerting values and a higher priority. Create a third of kind Site or Tag as you wish.
4. Use the Preview section before saving and confirm it lists which devices would be affected and what would change.
5. Open a test device > Policies tab. Confirm every setting is listed with the policy it came from and what it replaced. Check that the customer policy wins over the global one for its devices, and the "Enforced" option beats lower policies.
6. Add an exclusion (switch a device or site off for a policy) and confirm that device's Policies tab no longer shows that policy.
7. Test the results: change the offline minutes and confirm alerts follow it (see 1.2); change the business hours and confirm availability follows; set a remote access notice and start a remote session to see the notice; set a check profile in Check profiles and confirm the check plan on the device.
8. Delete a policy, then open History and use restore to bring it back. Confirm it works also for a deleted policy.
9. A device with no policy should behave exactly as before.
10. Not built yet (do not report): groups and tags beyond what exists, scripts in policies. Maintenance windows and patching are covered in 1.9 and 1.10.
Expected result: A device's effective settings follow the right policy, the Policies tab explains where each setting came from, preview matches reality and restore works.
Report if: A setting comes from the wrong policy; the Policies tab disagrees with what really happens (for example an alert threshold); Preview lists wrong devices; restore fails; a device with no policy changes behaviour; or a user without the right can edit policies.

### 1.32 Alert noise controls

Needs: A test PC with the agent; a way to make a check fail briefly then recover (a service you can stop and start); policy edit access.
Steps:
1. Go to Policies, open a policy that applies to the test PC, and open the Alerting section.
2. Set "Minutes a check must keep failing before it alerts" to 10 and "Reopen a cleared alert if it returns within (minutes)" to 30. Save.
3. Make a check fail (for example stop the monitored service). Wait through two check runs under 10 minutes and confirm no alert is raised. Start the service again before 10 minutes.
4. Stop the service again and leave it for more than 10 minutes. Confirm an alert opens (and a ticket if automatic tickets are on, see 1.4).
5. Start the service. Wait until the alert resolves (and ticket closes).
6. Within 30 minutes stop the service again. Confirm the SAME alert reopens (same number or entry, shown reopened) instead of a new alert and new ticket.
7. Wait more than 30 minutes after a resolve, then fail it again, and confirm a new alert is started.
8. Set both values to 0 and confirm alerts open at once and always start a new one.
Expected result: Short blips never alert; a returning problem within the set time reopens the closed alert and its ticket instead of creating new ones.
Report if: An alert opens before the minutes are up; a flapping problem creates several alerts or tickets; the reopened alert opens a second ticket; or zero does not switch the behaviour off.

### 1.33 Automation failures list

Needs: At least one online device and one offline or nobody-signed-in device; a script you can make fail.
Steps:
1. Go to Automation > Scripts and create a script that exits with an error (for example `exit 1`) or runs forever with a short timeout. Run it on an online device.
2. Run any script on a device that is switched off, or run a "signed-in user" install when nobody is signed in.
3. Open Automation > Failures.
4. Confirm your failed and timed-out runs appear, newest first, each with its reason.
5. Confirm the run that failed only because nobody was signed in is shown as Skipped, not Failed.
6. Use the What filter (Everything, Scripts, Updates, Device actions) and the Period filter (for example Last day) and confirm the list narrows correctly.
7. Run an update scan or install that fails and confirm it appears under Updates.
Expected result: Failed, Timed out and Skipped runs of scripts, update scans and installs and device actions are listed with a clear reason.
Report if: A failure you caused is missing; the reason is blank or unreadable; the sign-in case shows as Failed; the filters show the wrong rows; or old items appear above newer ones.

### 1.34 Customer limits across the system
Needs: A test user limited to one customer (Administration > Customer access), and at least two customers with devices, alerts and policies. An Administrator login to set it up.
Steps:
1. As Administrator open Administration, Customer access and limit the test user to one customer only.
2. Sign in as the test user. Open Customers and check only the allowed customer is listed. Try to create a customer and check you cannot.
3. Open Devices and the global search and check only that customer's devices appear. Open a device and check its software, checks, actions and files load; try to open a device of the other customer by pasting its link and check it is refused.
4. Open Monitoring > Alerts and the failures list and check only the allowed customer's items appear.
5. Open a device's policies and check only allowed ones show.
6. Write down anything from another customer you can still see in tickets, documents, assets, billing, or when starting a remote session by device link: those are known gaps, report what you find.
Expected result: The limited person sees only the one customer in customers, devices, alerts, failures and policies, and gets a refusal on others.
Report if: any device, alert, failure or policy of another customer is visible or openable, or the person can create a customer.

### 1.35 Groups
Needs: An Administrator login and two or more test users, a test customer with two sites, a tag on a few devices.
Steps:
1. Open Administration, then the Groups tab.
2. Add a group: give it a Name and Description. In the member list (Search people) tick a test user.
3. Give the group a permission the user's role lacks (for example the right to run scripts) and save.
4. Sign in as the test user (another browser or private window) and check the new permission works.
5. Edit the group: limit it to one customer, then to one site, then to a tag. Sign in as the test user each time and check they see only the devices of that customer, site or tag.
6. Open Administration > Users, open the test user and check the screen shows which group each permission and limit comes from.
7. Remove the user from the group and check the extra access disappears.
Expected result: Access is the role plus every group the person is in; limits are enforced by customer, site or tag; the Users screen explains where each permission comes from.
Report if: the user sees devices outside the limit, a permission from a group does not apply or does not go away, or the Users screen shows the wrong source.

### 1.36 Users and roles audit fixes
Needs: An Owner login and a test Administrator, Operator and Viewer user. Use test accounts only.
Steps:
1. Open Administration > Users (it should list everyone, not stop at 25 if you have more).
2. Edit the Operator role (Roles tab), remove one permission, then sign in as an Operator and check it is really gone. Try editing the Owner role and check Owner keeps everything.
3. Sign in as the Operator-level Administrator and try to give another user a permission or role you yourself do not have. Check it is refused.
4. Try to change, suspend or delete a user more powerful than you. Check it is refused.
5. Try to suspend, delete or change the role of your own account. Check it is refused.
6. Reset the password of a test user who is signed in on another browser, and check that browser is signed out. Do the same with Suspend.
7. Try to Invite or create a user using an email that already exists. Check the existing account is not changed. Try an invite with a role name that does not exist and check you get an error.
Expected result: Each of these attempts is refused with a clear message; resets and suspensions sign the person out.
Report if: any action above succeeds when it should not, the other browser stays signed in, an existing account is overwritten, or the list is cut at 25 people.

### 1.37 Linux patching

Needs: A Linux VM or server with agent 1.3.34 or newer (Ubuntu, Debian, Fedora, Rocky/Alma or openSUSE; a real machine has not been tried yet) with some pending updates; policy edit access.
Steps:
1. Open the Linux device > Patch tab. Click Scan Now and wait for the update list.
2. Confirm the packages show, with a security flag on security updates, any held packages marked, and a "restart needed" indicator when a kernel or core library was updated.
3. Pick a package (or use the install option) and click Install. Confirm status changes and the package version changes on the machine (for example `apt list --installed` or `rpm -q`).
4. In Policies > Patching set "Install updates automatically" to "Critical and important updates (security updates on Linux)" and Save for this device. After the next scan confirm only security updates install.
5. Set "Every update" and confirm all install.
6. Place a hold on a package on the machine (`apt-mark hold <pkg>`) and confirm it shows as held and is not updated.
7. Go to Reports and open the patching report and confirm the Linux device and its updates appear.
Expected result: A Linux device scans, installs and auto-patches like a Windows one, with security flag, held packages and restart-needed shown correctly, and appears in reports.
Report if: The scan shows no updates when `apt/dnf` says there are some (name the distribution); a held package gets updated; the security flag is wrong; restart-needed is not shown after a kernel update; or the device is missing from the reports.

### 1.38 Dashboard redesign

Needs: Any account; ideally one with different permission levels to compare; a console with several customers and a few alerts, tickets and devices. Also try a brand new, empty install if you can (this is the least tested).
Steps:
1. Sign in and open Overview (the home page).
2. At the top find the status strip: Online, Offline, Critical, Warning, Total. Click each and confirm it takes you to a matching filtered list. Compare Total with the device list count.
3. Find the Needs attention list. Confirm it lists real problems (urgent items first, "Show fewer" collapses it, "All clear" appears when empty) and that each item opens the right page.
4. Under At a glance check the cards: Security, Patching, Service desk, Today's schedule, Agent versions, Recent activity. Use the Show or hide cards control to hide and show individual cards (Hide all, Show all). Click through the links (View security, View patch report, View tickets, Open calendar, Manage agents, View audit log).
5. Use the Customer filter at the top: pick one customer and confirm every number changes; pick All customers again.
6. Expand the Fleet breakdown section and confirm the earlier charts appear (devices by operating system, by customer, offline devices, status).
7. Sign in as a person with fewer permissions (for example a technician without billing or security rights) and confirm cards they may not see are absent, not broken.
8. On a new empty install, confirm the start panel shows steps (Add a customer, Create an installer, Install the agent on a computer) and ticks them off as you do them.
9. Note there is no day-over-day trend; do not report that.
Expected result: The overview matches the real data on other pages and each section appears only for people allowed to see it.
Report if: A number differs from the list it links to; a card shows an error or spins forever; a section is visible to someone without that permission; the customer filter leaves some cards unfiltered; the start panel does not tick off; or the page is slow (over 5 seconds).

### 1.40 Device lists counted and paged by the server

Needs: A console with a large number of devices (the test environment has about 3,300); an account that can see them all.
Steps:
1. Open Overview and note the Total device count. Open the device list and confirm its total matches (not stopping at 1000).
2. Scroll or page to the last page of the device table and confirm devices exist there. Change page size if offered.
3. Click a column header (name, status, last seen) to sort, and confirm the whole list reorders, not just the visible page.
4. Use the filters rail (status, OS, customer) and the search box, and confirm the count and results change and match what you expect.
5. Open the customers tree and confirm customer device counts add up to the total.
6. In Automation > Scripts click Run on a script and look at the device list in the Run dialog; search for a device far down the list.
7. Open the target picker (for example when creating a check on Alerts > Checks > New check, Runs on) and search for a device by name.
8. Open a device page of a device far down the list (not within the first 1000) and confirm all tabs load.
Expected result: Counts, sorting, filters and search work across all devices, and nothing is limited to 1000.
Report if: Any list stops at 1000; counts differ between Overview, device list and customers tree; sorting only affects one page; search misses a device that exists; or a page takes more than a few seconds.

### 1.41 Finish the server-side device lists

Needs: A console with a large number of devices; a ticket to open; permission to save device views.
Steps:
1. Open a ticket (Tickets > open one) and use its device picker. Type part of a device name, including one far down a large list, and confirm results come from the full list and a device can be picked.
2. Go to the device list and set filters: status, OS, customer and a tag. Save the view (saved views) with a name.
3. Switch to another view and back to the saved one. Confirm the filters are re-applied and the count matches.
4. In the saved view, add a filter that the server cannot use and confirm the view lists it as "not applied" rather than silently ignoring it.
5. Repeat with the largest customer so that over a few thousand devices are involved.
Expected result: The ticket device picker searches the whole fleet; saved views apply status, OS, customer and tag filters server-side and clearly label filters that are not applied.
Report if: The ticket picker cannot find an existing device; a saved view shows the wrong devices or count; a filter is silently ignored without the "not applied" note; or it is slow or times out with thousands of devices.

### 1.42 Registry browser and editor

Needs: A Windows PC with the agent that you can afford to experiment on (a throwaway VM is best; do NOT use a production machine). Owner account, or one granted the devices.registry.write right (without it you can browse but not edit). This has not been run on a real device yet, especially HKLM writes.
Steps:
1. Open the Windows device > Registry tab.
2. Browse: expand HKLM and HKU in the Registry keys tree, open HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion and confirm values show in the table. Use the Search in and Search text boxes with the Search button.
3. Try HKLM\SAM and HKLM\SECURITY. Confirm they show "Blocked key". Confirm secret-named values (such as a value with "password" in its name) show as hidden.
4. Go to Admin > Audit logs and confirm each look was recorded.
5. Edit (needs the write right): create a test key under HKLM\SOFTWARE with Create key (name it AdgRmmTest). Use Add value with a name, Value type (for example String) and Data.
6. Change the value (Edit value; the confirm dialog shows old and new values). Type the device name to confirm where asked. Check on the PC in regedit that the value changed.
7. Open Recent changes and click Undo on the change; confirm the old value returns. Delete the value (Delete value) and delete the empty key (Delete key).
8. Collision check: open the same value in two browser windows, change it in one, then try to save a change in the other; confirm a "Changed since you looked" warning.
9. Try to write to a blocked area (Session Manager, SafeBoot, Winlogon, UAC settings, Defender, Image File Execution Options, ADG RMM's own keys). Confirm "Not allowed".
10. Try writing under the Run or RunOnce key or AppInit_DLLs. These are not blocked yet. If the edit goes through, report it (do not go further than adding a harmless test value, then undo it).
11. Make many quick changes and confirm "Too many changes" appears.
12. Try an offline device and confirm "The device is offline".
Expected result: Reading works with blocked keys and hidden secrets; edits need the write right, show old and new values, change the device, can be undone and are recorded in the audit log without data. Blocked areas refuse.
Report if: A blocked key can be read or written; a secret value shows its data; an edit appears to succeed but regedit shows no change (or the reverse); undo does not restore; no collision warning; the audit log is missing entries; the Registry tab appears on a Linux device; or the Run keys and AppInit_DLLs can be edited (known gap, still report what happens).

### 1.43 Network traffic and disk activity graphs

Needs: A Windows PC and a Linux machine with agent 1.3.36 or newer (a real Linux machine and a non-English Windows have not been tried; use those if you have them).
Steps:
1. Open the device > Overview tab. Scroll to the Performance history section.
2. Find the graphs named Network traffic (bits per second) with Received and Sent, and Disk activity (bytes per second) with Read and Write.
3. Generate traffic: download a large file on the PC; copy a large file on the disk.
4. After about 10 minutes, refresh the device page and confirm the Received line (and the Write line for copying) bumps.
5. Check the unit labels and sizes look sensible against what Task Manager or `iftop`/`iostat` showed.
6. Repeat on the Linux machine. On a Windows PC set to a non-English language (for example German or French) confirm the graphs still fill with data, not zero or blank.
7. Confirm that no alerts appear for these graphs.
Expected result: Both graphs show real network and disk activity on Windows and Linux, including non-English Windows, with no alerts.
Report if: Graphs are blank or flat zero though activity occurred; values are off by a large factor; a non-English Windows shows nothing; the Linux device shows no graphs; or an alert is raised from them.

### 1.44 Linux security scan and device facts

Needs: A real Linux server or laptop with agent 1.3.37 or newer. That agent is in the candidate slot: ask the admin to promote it in Admin > Agents & endpoints, or put the Linux device in the pilot ring first. Test on a real machine (the notes say only containers have been used).
Steps:
1. Open the Linux device page and click the Security tab. Click Scan now. Wait for the result.
2. Confirm a score and grade appear, with 18 checks listed (firewall, SSH, empty passwords, extra UID 0 accounts, old remote services, OS support end date, package updates, automatic updates, SELinux or AppArmor, LUKS disk encryption (also under LVM), clock sync, disk space, sudo users, restart waiting, malware scanner, Secure Boot).
3. Compare each result with reality on the machine: for example turn the firewall off and rescan; set `PermitRootLogin yes` in SSH and rescan; confirm the corresponding check goes to Problem.
4. Confirm the OS support end date matches the real one for your distribution.
5. Open the device Overview and confirm facts: OS, last boot, firmware, network, firewall, encryption, TPM, Secure Boot and antivirus are filled in.
6. Go to the Security page (fleet) and confirm the Linux device is in the list; use the Not scanned tile and grade filters. Create a schedule for scans and a bulk scan from the device list. Run the Security posture report on the Reports page and confirm the device is included.
7. On a Windows device confirm the Defender actions still exist there; they should not appear on Linux.
8. Optional for a developer or admin: run the agent with `--facts` on the machine to check support.
Expected result: A real Linux machine gets an accurate score, grade and per-rule findings, correct device facts, and shows up in the fleet page, schedule, bulk scan and report.
Report if: A rule says Pass when it clearly fails (or the opposite); the scan hangs or never returns; the score looks wrong against the rules; facts are blank or wrong; the support end date is wrong; or the device is missing from the fleet page or report. Include the distribution and version.

### 1.45 Device removal request queue

Needs: Two accounts: one that can only see devices (and may request removal) and one that can delete devices (for example Owner or admin); at least two throwaway test devices (they will be deleted).
Steps:
1. As the first account, open each throwaway device row and use Request removal (on the device list or the device menu). Give a reason for one and none for the other.
2. As the account with delete rights, open Removal requests (use the search box if you cannot find it, or the Needs attention list on Overview, or the Request removal result link).
3. Confirm each request lists the Device, Customer, reason (or "No reason given"), Asked by and when, oldest first.
4. Tick one request and click Decline. In the confirm dialog (Decline 1 request?) confirm. The device must still exist on the device list.
5. Tick the other and click Delete. In the dialog (Delete 1 device?) confirm. Confirm the device is gone and shows Deleted in the result.
6. Make several requests and test the select-all checkbox with both actions.
7. Sign in as the first, limited account and confirm they can see the list but not approve or decline; sign in as a limited person restricted to some customers and confirm they only see those customers' requests.
8. Open Admin > Audit logs and confirm each answer is recorded per device.
Expected result: All pending requests are in one list; only people with delete rights can approve or decline; approval deletes the device; decline keeps it; limited people see only their own customers; all is audited.
Report if: A device is deleted without a waiting request; Decline deletes or does nothing; approval does not delete; the wrong customers' requests are shown; users without the right can answer; or the audit log is missing entries.

### 1.46 Alert notifications to Slack, Discord and Teams

Needs: A Slack, Discord or Microsoft Teams (Workflows) incoming webhook URL that you own and a channel to receive it. This has only been tried against a local receiver, never against the real services, so this test is the important one.
Steps:
1. Go to Alerts > Notifications and settings. Under Notification channels click to add a channel. Choose Type "webhook", give it a Name and paste your webhook URL into Address.
2. Open the Message format dropdown. Confirm Automatic (from the address) is the default and the other choices are Slack (also Mattermost and Rocket.Chat), Discord, Microsoft Teams and ADG RMM JSON.
3. Leave it on Automatic, set "Send" (the severity) as desired, and click Add channel.
4. In the channel list click Test. Confirm a message arrives in the chat channel, readable and well formatted ("Test sent to <name>" appears in the console).
5. Cause a real alert (see 1.1) and confirm the alert message arrives with title, device, severity and the alert's details.
6. Change Message format by hand to the wrong one (for example Discord for a Slack URL) and click Test. Confirm the console shows what the receiver said as the error.
7. Delete the webhook inside the chat service (so it answers 404) and cause another alert. Confirm ADG RMM does not keep retrying forever and the error text is visible. Repeat for each service you can.
8. Add a webhook with another address (your own test receiver) and confirm it gets ADG RMM's own signed JSON.
Expected result: Test and real alerts arrive properly formatted in Slack, Discord or Teams; wrong settings produce a readable error; receivers that refuse are not retried repeatedly.
Report if: A test shows "failed" with a 400 error; the message arrives as raw JSON in a chat; the message is missing the device or severity; Teams or Discord shows an empty card; the same refused alert is sent again and again; or the Message format choice is ignored.

### 1.47 Linux packages: install and remove

Needs: A real Linux machine (not just a container) with agent 1.3.34 or newer; apt, dnf, yum or zypper based. Use a test machine you can afford to break and reach by SSH as a fallback.
Steps:
1. Open the Linux device > Software tab.
2. Click Install software. The dialog is titled "Install software". Type a harmless package name (for example `htop` or `tree`) and confirm.
3. Watch for "Install queued", then success. On the machine run `which htop` and confirm it is installed.
4. Find the package in the list, open its row and click Uninstall. Confirm in the dialog. Confirm it is removed on the machine.
5. Try removing a protected package, for example `openssh-server`, `sudo`, `systemd`, the kernel, the package manager (`apt`/`dnf`), the firewall (`ufw`/`firewalld`) or the ADG RMM agent. Confirm each is refused and the console explains why, and verify nothing was removed on the machine.
6. Try removing a package where other packages depend on it (for example a library used by other programs). Confirm the refusal says it would take other packages with it and that nothing was removed.
7. Type a package name with odd characters (for example `foo; touch /tmp/x`) and confirm it is rejected or fails safely, and that `/tmp/x` was not created.
8. Open Admin > Audit logs or the software install log and confirm the actions are recorded.
Expected result: Packages install and uninstall by name; protected or dependency-heavy removals are refused with nothing changed; odd input cannot run commands.
Report if: A protected package or one with dependents is removed; a refusal still removes something; weird input creates the file or runs anything; install says success but nothing installed; or it fails on your distribution (say which).

### 1.48 Linux security actions
Needs: A real Linux machine (VM is fine) with the agent installed, online in the console, with ufw or firewalld already installed and ClamAV already installed (see 1.55). Your login needs the right to run device actions. Keep a second SSH session open to the machine before you start.
Steps:
1. Open the console, go to Devices, open the Linux device, then open its Security tab.
2. Press Turn on firewall. Read the confirmation text, then confirm with the button of the same name.
3. Wait for the result message. Then in your separate SSH session run `sudo ufw status` (or `sudo firewall-cmd --state`) and check the firewall is on and that your SSH connection still works (open a new SSH session).
4. Press Malware scan and confirm. Leave the page, come back after a few minutes and open the Security tab again.
5. On the machine, create a harmless test file in your home folder: `echo 'X5O!P%@AP[4\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*' > ~/eicar.txt`, run the scan again.
6. Check the file is still there afterwards (`ls ~/eicar.txt`).
Expected result: The firewall turns on without cutting off SSH. The scan finishes and reports the EICAR file as found, and the file is NOT deleted or moved. If no firewall tool is installed, you get a clear message and nothing gets installed. An entry for each action appears in the audit log.
Report if: you are locked out of SSH, the firewall tool gets installed by ADG RMM, the scan never finishes, the scan misses the EICAR file, the scan deletes or moves the file, a user without the device actions right can still press the buttons, or no audit entry appears.

### 1.49 Patch list catches up after an install
Needs: A Windows PC and a Linux machine (Ubuntu or Debian preferred) with the agent, each with at least two pending updates.
Steps:
1. Open Devices, open the Linux device, open the Patch tab. Press Scan and wait until the Required list shows the updates.
2. Select two updates and install them (use the install button on the tab). Do NOT press Scan afterwards.
3. Wait a few minutes after the install finishes, without touching anything. Reload the Patch tab.
4. Also right after the install finishes (before the automatic scan lands), look at the list: the updates you installed should already show as Installed.
5. Install a second batch straight after the first, then check the list again.
6. Repeat steps 1 to 3 on the Windows PC.
Expected result: Installed updates move out of the Required list by themselves, on both systems, without pressing Scan. Only one automatic scan runs after an install, not one per update.
Report if: installed patches stay under Required after 10 minutes, patches show as Required that you installed, or the device keeps scanning over and over.

### 1.50 Linux agent tested on more distributions
Needs: Linux machines or VMs. Ideal: one of Debian 12, Ubuntu 22.04 or 24.04, Fedora 40 or newer, and especially Rocky 9 and openSUSE Leap 15.6 (these were not tried as services). An ARM machine is optional (not supported yet).
Steps:
1. In the console, go to Devices and use the Add device or install command shown there for Linux; run it as root on the machine.
2. When the installer finishes, wait up to two minutes and check that the device appears in the Devices list and goes online.
3. Open the device and check the overview shows the operating system, version and hardware facts.
4. Open the Patch tab and press Scan, then check it lists updates.
5. Open the Software tab, install a small package (for example `htop`), then remove it.
6. Uninstall the agent using the uninstall command from the install page and check the device stops being online.
7. On a machine with no OpenSSL or no tar, run the installer and read the message.
Expected result: Install, enrolment, facts, scan, install and remove of a package and uninstall all work. A missing tool produces a message saying exactly what is missing instead of a crash.
Report if: the device never appears, shows wrong or empty facts, the service does not start after a reboot, an update scan fails, or the installer fails with an unclear message (send the distribution name and version).

### 1.51 Network discovery
Needs: A Windows PC and a Linux machine with the agent online at a real customer or office site with a mix of devices (a printer, router, other PCs, ideally a NAS). Your login needs the device actions right.
Steps:
1. Open the top bar Devices dropdown, choose Network discovery.
2. Press Scan network. In the dialog choose a Customer, a Site (try All sites of this customer) and a Device (try All online devices of this site). Start the scan.
3. Wait for it to finish. Check the host list: addresses, MAC addresses, names, guessed types (printer, camera, Windows, Linux and so on) and where each name came from.
4. Compare with what you know is on the network. Check managed devices are recognised as managed.
5. Tick a host and press Ignore. Switch the status filter to see ignored hosts, then tick it and press Stop ignoring.
6. Open a Windows or Linux device, open its Network tab and press the scan button there. Check the results match. Press Monitor a device from here on one host to start SNMP monitoring (see 1.53).
7. Scan a site where a router or VPN answers for many addresses and check the scan says some were left out rather than showing hundreds of fake rows.
8. Check a printer or NAS gets a name from NetBIOS or mDNS when DNS does not know it.
Expected result: Real hosts are found once each, even when several devices scan; names show their source; no logins or changes happen on the hosts; ranges that are not private addresses are refused.
Report if: known devices are missing, one device appears as many rows, a managed device is not recognised, the scan hangs, a public address range is accepted, the guessed type is wrong, or any device on the network complains about the scan.

### 1.52 Scheduled network scans and alerts for new devices
Needs: A customer site with at least one online Windows or Linux device, access to the Alerts page, and ideally email or webhook alerting configured. A real week of scans is the actual test, so plan to check back over several days.
Steps:
1. Open Devices > Network discovery. Press Add a schedule.
2. Choose the Site, an interval (start with the shortest, every hour), optionally a preferred device, and turn alerts on. Save.
3. Wait for the first scan. This is the baseline: confirm NO alerts appear for it.
4. Plug a new device (a phone or laptop) into the network, wait for the next scan, then open Monitoring > Alerts.
5. Confirm there is one WARN alert for the new host, on the scanning device. Open it from Alerts.
6. On Network discovery, tick the new host and press Ignore. Check the alert closes.
7. Switch off the preferred scanning device and wait for the next scheduled time: check another online device does the scan. Switch off all devices of the site and check the page says why no scan ran.
8. Use Edit, then the on/off button, and Remove on the schedule row.
9. Leave it for several days and check scans keep running at the interval, one at a time.
Expected result: Baseline raises nothing; each new unmanaged host raises one WARN alert; alerts close when ignored or when the host becomes a managed device; more than 10 new hosts at once gives a single summary alert.
Report if: the baseline raises alerts, a new host raises none, alerts duplicate, alerts never close, two scans of one site overlap, the schedule stops running after a few days, or email or webhook notifications do not arrive.

### 1.53 SNMP monitoring of network devices
Needs: A real SNMP printer (best), a managed switch or router with SNMP enabled and its community string, plus an online Windows or Linux device on the same site. On a Linux poller install the snmp package from the device's Software tab first.
Steps:
1. Open Devices > Network devices (SNMP). Press Add a device.
2. Choose the Site, enter the device address, the community string, the SNMP version (1 or 2c), a polling interval, and optionally the poller device. Save.
3. Press Poll now on the row. Check the device shows as answering, with name, uptime, and for a printer the supply bars (toner and so on) and status.
4. For a switch, open the row detail and check the ports show up or down correctly against the real ports (unplug a cable and poll again).
5. Open the detail and check that the community string is not shown anywhere.
6. Try Add as asset in the detail and check what happens; try the on/off button and Stop monitoring.
7. Make an alert happen: switch the printer off and wait for 3 polls (alert: not answering). Open the printer tray to simulate paper out or jam, and, if you have a low toner printer, check the supply alert (WARN at 10 percent, CRIT at 3 percent). Check these in Monitoring > Alerts.
8. Switch the printer back on and fix the fault: check the alerts close.
Expected result: Values match what the device's own web page shows; faults and low supplies raise alerts that clear when the condition ends; the community string never appears in the page or audit log.
Report if: values differ from the device, ports show the wrong state, alerts do not appear or do not close, alerts flap on and off near 10 percent, the community string is visible anywhere, or the poll never answers although the device is reachable from the poller.

### 1.54 Device secrets on Linux
Needs: A real Linux machine with the agent (ideally with a LUKS2 encrypted disk that unlocks by TPM or key file; a plain machine is fine for the password part), and a login with the right to manage and reveal device secrets. A developer is needed for policy switches if they are not already on.
Steps:
1. Open Devices, open the Linux device, Security tab, find the Device secrets card.
2. In the Local administrator password block press Rotate now and confirm with Rotate password. Wait for the device to answer.
3. When it shows the account (default adg-admin) and a last changed time, press Reveal, give a reason, and copy the password.
4. On the machine, log in as that account with the password (for example `su - adg-admin`) and check it works and is in sudo or wheel.
5. Press Rotate now again and check the old password stops working and the new one works.
6. In the Disk recovery keys (LUKS) block press Escrow keys now and confirm. Check the key list, or the reason a disk was skipped.
7. If you have a TPM-unlocked LUKS2 disk: Reveal the key and test it with `sudo cryptsetup luksOpen --test-passphrase /dev/<disk>`, entering the key.
8. Check the Secret access log on the Security page shows your reveals and rotations.
Expected result: The password is generated, set and confirmed on the device; the old one stops working. Eligible LUKS2 disks get one new recovery key slot; ineligible disks are listed with a reason; nothing is removed from the disk.
Report if: the password does not work on the device, a system account or root gets changed, the disk loses an existing key slot or fails to boot, the revealed recovery key does not unlock the disk, the TPM disk is reported wrongly, or reveals are missing from the access log.

### 1.55 ClamAV install and signature updates on Linux
Needs: Linux machines with the agent: Ubuntu or Debian, and if possible Rocky, Alma, openSUSE or Arch. A Red Hat machine only to check the message.
Steps:
1. Open Devices, the Linux device, Security tab.
2. Press Install ClamAV and confirm. Wait until it finishes (can take several minutes).
3. On the machine check it is installed (`clamscan --version`) and that no always-on service is running (`systemctl status clamav-daemon` should be missing or inactive).
4. Press Update signatures and confirm; check a success message and a recent signature date.
5. Check the Security tab now shows the Malware scanner as in place.
6. Press Malware scan with the EICAR test file from 1.48 in your home folder and check it is found.
7. On a Red Hat system, press Install ClamAV and read the message about enabling EPEL.
8. Disconnect the machine from the internet and press Update signatures; read the failure message.
Expected result: ClamAV installs by the system's own package manager, signatures update, and scans find EICAR. Failures give readable messages.
Report if: install fails on a supported system, signatures stay old, the Security tab still says no scanner after install, a daemon is left running, or an error message is unclear.

### 1.56 Linux inventory closer to Windows
Needs: Linux machines with the agent 1.3.38 or newer, ideally Ubuntu plus one Alpine and one Arch machine.
Steps:
1. Open Devices, open the Linux device, look at the overview.
2. Check the manufacturer and model are shown together (for example Dell Latitude 5420) and the processor shows its name with core and thread counts. Compare with `lscpu` on the machine.
3. Open the Software tab on the Alpine and Arch machines and check installed packages are listed; compare a few with `apk list --installed` or `pacman -Q`.
Expected result: Manufacturer, model, CPU name, cores and threads match the machine; software lists show real packages.
Report if: model or CPU is blank or wrong, counts differ from `lscpu`, or the software list is empty on Alpine or Arch. Warranty dates and peripherals are not part of this step.

### 1.57 Alpine and OpenRC support
Needs: A real Alpine Linux machine or VM (3.20 or newer), or Gentoo or Artix with OpenRC. Root access.
Steps:
1. On the machine run `apk add bash curl`.
2. In the console copy the Linux install command for the right customer and run it as root. Check the device appears and is online.
3. Reboot the machine and check the agent comes back by itself. Kill the agent process (`pkill -f adgrmm` or similar name) and check it is restarted within a minute.
4. Open the device, Scripts: run a small script and a remote shell session. Check both work.
5. Open the Software tab, install a package by name (for example `nano`), then remove it.
6. Press Malware scan on the Security tab after installing ClamAV.
7. Open the Patch tab and press Scan or an install: check it is refused with a message, not a crash.
8. Wait for an agent update (or ask the support contact to release one) and check the agent updates itself and keeps running.
9. Uninstall the agent with the uninstall command and check the service is gone.
Expected result: Everything above works except patching, which gives a clear refusal. runit, sysvinit, s6 and ARM are not supported.
Report if: install fails, the service does not survive a reboot or a kill, scripts or shell do not run, software install fails, the self-update leaves the device offline, or uninstall leaves files behind.

### 1.58 Installers set the device clock first
Needs: A Windows PC and a Linux machine whose clocks you can set wrongly on purpose (a VM is best, turn off automatic time first). Administrator or root rights. Do not do this on a production machine.
Steps:
1. Windows: turn off Set time automatically in Settings, Time and language, and set the date 2 days back. Run the install command from the console in an administrator PowerShell window.
2. Watch the installer output for a line about the clock. Afterwards check the Windows clock is correct (within a minute) and the device is online in the console.
3. Linux: run `sudo timedatectl set-ntp false; sudo timedatectl set-time '2026-01-01 10:00:00'` and then run the install command as root.
4. Check the clock is corrected afterwards and the device enrols.
5. On a machine with a correct clock run the installer and check it does not touch the clock.
Expected result: A clock more than five minutes off is corrected during install and the device enrols; a correct clock is left alone.
Report if: install fails with a certificate or time error, the clock is left wrong, the clock changes on a machine that was right, or the clock is set to a wildly wrong date.

### 1.59 Tools menu: bulk command, bulk script, bulk patch management, recover agents, server maintenance, clear cache
Needs: At least a handful of online devices (Windows and Linux), ideally 20 or more to see the tick box, plus an Administrator login. Use a test customer. Do not install updates on real production machines without agreement.
Steps:
1. Look at the top bar: open the Tools dropdown. Check which tools you see (Bulk command, Bulk script, Bulk patch management, Recover all agents, Server maintenance, Clear cache). Log in as a lower role and check you see fewer.
2. Choose Bulk command. Under Where choose one customer (the dropdowns are Customer, Site, System: Windows and Linux, Windows only, Linux only). Note the device count shown. Type `hostname` as the command, Run.
3. Open the Recent actions list and open the new batch. Check each device shows its own answer.
4. With 20 or more devices in the choice, check you must tick "I have checked the command and that these N devices are the ones I mean" before the button works.
5. Choose Bulk script, pick a harmless script (for example a system summary one), fill the parameters, run it on one site.
6. Choose Bulk patch management: choose Scan for updates on one site. Check results arrive per device. Only try Install critical and important updates on a test device.
7. Choose Recover all agents on one test site and check the agents come back online (they restart). On Windows this restart is the unproven part: watch a Windows device in Devices and report whether it goes briefly offline and returns, and whether a scheduled task is left behind in Task Scheduler.
8. Choose Server maintenance. Press the preview button first and read the counts. Run it only when the person responsible agrees, then check tickets, devices, settings and the audit log are untouched.
9. Choose Clear cache and confirm. Check the dashboard and policies still load normally.
Expected result: Each tool shows how many devices it reaches before anything runs, each device answers separately, big batches need the tick box, and nothing outside the stated history is deleted.
Report if: the count shown is wrong, devices outside your choice are touched, a Windows agent does not come back after Recover all agents, a batch has no per-device results, the tick box is missing at 20 or more, or tickets, devices or open alerts disappear after Server maintenance.

### 1.60 Top bar in category dropdowns
Needs: A computer browser, and a phone or a narrow browser window.
Steps:
1. Open https://console.example.com and sign in.
2. Check the top bar shows Dashboard, Customers and then dropdowns Devices, Monitoring, Service desk, Automation, Business and Tools.
3. Click Devices. Check it lists Assets, Network discovery, Endpoint backups, Network devices (SNMP), Session recordings and Removal requests (some may be hidden if you lack rights).
4. With Devices open, move the mouse over Monitoring without clicking. Check Devices closes and Monitoring opens.
5. Click Network discovery. Check the Devices title now looks highlighted as current while you are on that page.
6. Open the site on a phone (or narrow the window) and open the menu drawer. Check the same groups appear under headings.
Expected result: Menus behave like a desktop menu bar and the current group is highlighted.
Report if: an item is missing, a menu stays open on top of another, the current group is not highlighted, or the phone drawer differs from the groups above.

### 1.61 Built-in scripts library
Needs: A Windows PC and a Linux machine with the agent, and a login with the right to run scripts.
Steps:
1. Open Automation > Scripts and automation.
2. Check you see category tiles and a Built-in badge on scripts. Use the search box (Search scripts) to look for "disk".
3. Open a read-only script such as a disk space or system summary script and run it on a Windows device and on a Linux device. Check the output is sensible.
4. Open a script that changes something (for example clean temp files or restart a service). Run it with Confirm left empty or NO and check it only reports (dry run) and changes nothing.
5. Run it again with Confirm set to YES in capital letters on a test machine only. Then try "yes" in lower case and check it is NOT accepted.
6. Try Delete and Edit on a built-in script. Read what the page says (deleting is blocked or can be brought back with Restore).
7. Press the copy icon (Make a copy, aria name Duplicate) on a built-in, and check you get an editable copy.
8. Type odd characters like `; whoami` or `$(id)` into a parameter and run: check it is treated as plain text and nothing extra runs.
Expected result: 45 built-in scripts across nine categories, dry run by default, YES (exact case) required to change anything, injection through parameters does nothing.
Report if: a changing script acts without YES, lower-case yes is accepted, injected text runs, a script fails on a clean machine, or a built-in can be permanently deleted with no way to bring it back. Actions that need administrator rights or real disks are the least-tested; focus there.

### 1.62 Script categories and the IDE editor
Needs: A browser on a computer and a phone, and logins: one that can write scripts, one that can also manage categories (right automation.categories.manage).
Steps:
1. Open Automation > Scripts and automation. Check scripts show as category tiles.
2. Click a tile. Check the scripts of that category appear and a button to go back (All categories) works, as does the browser Back button.
3. Click New script. In the editor check line numbers, colour highlighting, a status bar at the bottom, and press Ctrl+S to save.
4. In the editor use the Category dropdown to move the script to an existing category. As the lower login check you can pick a category but cannot create or delete one; as the manager login check you can create a new category from the dropdown and delete one from the tiles.
5. Edit a built-in script, save it, and check it now shows Customized. Press the reset icon (Reset to the original) and check the Customized mark goes away and the original text returns.
6. Open the page on a phone and use all of the above. Phone layout is the unproven part: write down anything cut off, overlapping or unreachable.
Expected result: Tiles, back navigation, IDE-style editor with Ctrl+S, correct rights for categories, and a reset that restores the original built-in.
Report if: the editor does not load, Ctrl+S does nothing, the wrong user can create or delete categories, reset does not restore, or the phone layout is unusable (include screenshot and phone model).

### 1.63 Tools: choose a tag, leave devices out, scripts per system
Needs: Several online devices (Windows and Linux) in a customer, at least one tag assigned to some of them, and a login with run rights.
Steps:
1. Open the Tools dropdown and choose Bulk command.
2. Under Where choose A tag and pick a tag (dropdown Choose a tag). Check the device list shows exactly the devices carrying the tag, each with a tick box.
3. Press Untick all, then tick two devices, or untick one, and check the count of devices to run on changes.
4. Run a harmless command (`hostname`). Check only the ticked devices got it in Recent actions.
5. Choose Bulk script. Set System to Windows only and check only Windows and both-system scripts are listed (the list names the system in brackets). Change to Linux only, then to Windows and Linux, and check the lists change as described.
6. In Scripts and automation open a script marked for both systems and check it has two tabs (PowerShell and bash). Run it on one Windows and one Linux device and check each ran its own part.
7. Check the Shell dropdown in Bulk command offers PowerShell for Windows only, bash for Linux only.
Expected result: Only ticked devices run; script lists follow the chosen system; each device runs the text for its own system.
Report if: unticked devices still run, the count is wrong, a script for the wrong system is listed, the wrong text runs on a device. If you have more than 1000 devices, tell us what happens (only the first 1000 can be ticked).

### 1.64 Scripts for Windows, Linux and macOS
Needs: A Windows PC and a Linux machine with the agent. A Mac cannot be tested: there is no macOS agent yet, so the macOS texts cannot run on any device (a developer reads them only).
Steps:
1. Open Automation > Scripts and automation and find scripts whose system is all systems (for example system summary, top processes, disk space, connection test).
2. Open one with the editor and check three tabs exist (PowerShell, Linux bash, macOS bash).
3. Run a read-only one on the Windows device and on the Linux device and compare the output with what you know about the machine.
4. Run a script that changes something (clean temp files, flush DNS, restart a service) with Confirm empty and check it does nothing. Then try YES on a test machine only.
5. Try the file hash script on a file you know and compare the hash with `Get-FileHash` or `sha256sum`.
6. Try the stop a process script with a harmless test process and with a name that does not exist.
Expected result: Each device runs its own system's text; changing scripts need Confirm=YES; outputs are correct.
Report if: the wrong text runs, a changing script acts without YES, output is wrong or errors, or one of the 24 scripts is missing.

### 2.1 Decide which unfinished tabs to hide until they're real
Needs: A browser and an Owner login.
Steps:
1. Open Administration (top right menu > Administration).
2. Expand each group in the left list: General, Access Management, Billing, Communications, Infrastructure, Advanced.
3. Write down every tab you see.
4. Click each tab once.
Expected result: Only working tabs are listed. For example, Access Management shows Users, Roles, Groups, Customer access, SSO, Security Policies, Session Mgmt, Roles Matrix. The Notifications tab and the Billing group's Subscription, Billing and Invoices tabs are not in the list. Every listed tab opens a real screen with a heading and loads data (no "coming soon" placeholder, no endless spinner).
Report if: A tab opens an empty placeholder or a form whose Save button does nothing; a tab you expected is missing; clicking a tab shows an error.

### 2.2 Audit log: record and show who did what
Needs: A browser and an Owner login. A second user account helps.
Steps:
1. Open Administration > Advanced > Audit Logs.
2. Make a change that should be recorded: for example open Administration > General > Company, change the phone number, save, then change it back.
3. Return to Audit Logs and press refresh or reload.
4. In "Search the audit log" type the word "company" (the box takes an action, person, target or IP address).
5. Use the filters (Who, Category, Outcome with Success or Failure, From date, IP address) and narrow the list.
6. Try one failed action, for example sign out and attempt a sign-in with a wrong password, sign back in, and look for a Failure row.
7. Use the CSV export button on the page and open the file in Excel.
Expected result: Your change appears with time, who, action, target, outcome and IP address. Filters narrow the list correctly. The failed sign-in shows as Failure. The CSV opens and matches what the page shows (with the same filters applied).
Report if: A change you made is missing; the person or IP is wrong; filters return unrelated rows; the CSV is empty or garbled; the list is slow (more than 10 seconds).

### 2.3 Notification settings
Needs: A browser and an Owner login.
Steps:
1. Open Administration and look through all groups for a tab called "Notifications".
2. Open Alerts in the top menu (Monitoring > Alerts) and find the alert notification settings screen there.
3. Change one setting (for example who is told), save, reload, and confirm it kept.
Expected result: There is no Notifications tab in Administration. The working notification settings are under Alerts, and the saved choice is still there after a reload.
Report if: A Notifications tab shows up under Administration; the settings under Alerts do not save or reset after a reload.

### 2.4 SLA settings
Needs: A browser, an Owner login, at least one customer.
Steps:
1. Open Administration > Advanced > SLA.
2. Under the calendar area, add a calendar: give it a name ("For example: Office hours"), a time zone, working days, working hours, and one holiday (Date). Save.
3. Under "Policies" add a policy ("For example: Standard support"). Set "First reply within" and "Resolved within" for at least one priority under "Targets by priority". Set "Warn at". Save.
4. Press "Make default" on that policy.
5. Under "Customers with their own policy" add one customer and choose a different policy for them. Press "Assign".
6. Reload the page.
Expected result: The calendar, holiday, both policies, the default marker and the customer override are all still there. Saving with no days chosen shows "Choose at least one day." and a working day that ends before it starts is refused.
Report if: Anything you saved is gone after reload; an error appears on Save; the default marker is on the wrong policy.

### 2.5 Security policies
Needs: A browser and an Owner login, plus a second staff account (not an Owner) to test with. Do the IP list test only if you can keep another way in. A developer can switch limits off with the server switch if you lock yourself out. A Cloudflare Turnstile account with site and secret keys is needed for the CAPTCHA part only.
Steps:
1. Open Administration > Access Management > Security Policies.
2. Under "Passwords" set "Minimum length" to 14, tick the number and special-character rules, set "Do not allow reuse of the last … passwords" to 3. Save.
3. Sign in as the second staff user and try to change the password to a short one such as "abc123". Then try a good 14-character one. Then try changing back to the previous password.
4. Under "Sessions" set "Sign out when idle for (minutes)" to 2. Save. As the second user, leave the console untouched for 3 minutes.
5. Under "Where staff may sign in from" press "Add my address" and save. Open a private window and sign in as the second user from the same PC. Then try from another network (a phone on mobile data) as the second user.
6. Optional: under "CAPTCHA on the sign-in page" enter the Turnstile "Site key" and "Secret key", tick "Require the CAPTCHA to sign in", save, and open the sign-in page in a private window.
7. Part the notes say is not tested: with the address list set, sign in as a user who has two-step verification (2FA) and as an SSO user, and note whether the address list is applied at those steps. If your site sits behind a proxy, check that you are not wrongly blocked.
Expected result: Short, no-number or reused passwords are refused with a clear message; a good one is accepted. The idle user is signed out after about 2 minutes. The address list lets the listed address in and refuses others; Owners are exempt; saving an address list that excludes you is refused. The CAPTCHA box shows on sign-in and a failed one refuses the sign-in.
Report if: A rule is not enforced; you get locked out of your own account; the wrong address is let in or refused (especially at the 2FA or SSO step or behind a proxy); the sign-in page shows no CAPTCHA though it is switched on.

### 2.6 Single sign-on (SSO)
Needs: A real identity provider with an app registration (Microsoft Entra ID, Google or Okta) and a test user in it. Setup needs admin rights at the provider. This is the part never tried for real.
Steps:
1. At your provider, create an application and note the Issuer URL, Client (application) ID and Client secret. The page lists the redirect address to enter at the provider under "Set up at your provider".
2. Open Administration > Access Management > SSO.
3. Fill in "Issuer URL" (for Entra: https://login.microsoftonline.com/TENANT-ID/v2.0), "Client (application) ID", "Client secret", "Scopes", "Button text" (for example "Sign in with Microsoft"), "Allowed email domains" and "Role new people get". Save.
4. Press "Test provider" and read the result.
5. Open a private window to the console sign-in page and press the new SSO button. Sign in at the provider with your test user.
6. Try a user whose email domain is not in "Allowed email domains".
7. Leave "Turn passwords off once single sign-on is on" unticked for this test.
Expected result: "Test provider" reports success. The sign-in button appears, the provider asks you to sign in, and you return to the console signed in with the chosen role. A user from a disallowed domain is refused with a clear message.
Report if: Test provider fails with a valid setup; you return to an error page or loop back to sign-in; the wrong role is assigned; a disallowed domain gets in. Copy the exact error text.

### 2.7 Admin view of sessions
Needs: A browser, an Owner login, and at least two staff accounts that are signed in (use a private window or a second browser for the second one).
Steps:
1. Sign in as the second staff user in a second browser.
2. As the Owner open Administration > Access Management > Session Mgmt.
3. Use "Search sessions" to find the second user. Check Person, Device, Address, Signed in and Last active.
4. Find your own session and look for the "This session" mark.
5. End one session of the second user from the Actions column, then use the end-all option for that person if the page offers it.
6. In the second browser, click anything in the console.
7. Sign in as a lower role user and try to end an Owner's session.
Expected result: Sessions list correctly with device, address and times. Your own session is marked "This session" and cannot be ended. The second user is signed out after their session is ended. A person cannot end a more powerful person's session.
Report if: A session is missing or has the wrong device or address; you can end your own or an Owner's session; the ended user stays signed in.

### 2.8 Agent settings and rollout
Needs: A browser and an Owner login. A Windows PC with the agent helps for the update part.
Steps:
1. Open Administration > Infrastructure > Agents.
2. In "Install keys" find "How long a new key lasts". Change it and press save. Then open Administration > Infrastructure > Install keys, make a new key, and check its expiry matches.
3. In "Agent updates" switch "Offer new agent versions to devices automatically" off, save, reload and confirm it stays off. Switch it back on and save.
4. Look at "Newest package on this server" and compare it with the agent version on a PC under Devices.
5. Confirm there is no setting for heartbeat interval or maintenance scripts (they were deliberately removed).
Expected result: The key lifetime and automatic updates setting both save and survive a reload; new keys use the new lifetime. No heartbeat or maintenance-script settings are shown.
Report if: A setting resets after reload; a new key's expiry does not match; devices keep being offered updates when automatic updates are off.

### 2.9 Secrets
Needs: A browser and an Owner login.
Steps:
1. Open Administration > Advanced > Secrets (heading "Secrets & Environment").
2. Scan the list: each setting should show set or not set and where it is configured. Use "Search settings" to find one (for example "smtp").
3. Look for any value displayed in full.
4. Check the "Nothing needs attention" note or the list of unset items.
5. Open Administration > Advanced > Audit Logs and search for the view you just did.
Expected result: The list is read-only, never shows a secret value, and says where each is set. Your viewing is in the audit log.
Report if: Any password, key, token or secret value appears on screen; the page lets you edit values; viewing is not audited.

### 2.10 Roles matrix
Needs: A browser, an Owner login, and a non-owner staff login for the permission part. Use a test role, not a real one.
Steps:
1. Open Administration > Access Management > Roles first and create a role named "Test role".
2. Open Administration > Access Management > Roles Matrix. Find the "Permission" column and the Test role column.
3. Tick one permission for Test role and save. Check it on the Roles tab too.
4. Try to change the Owner column.
5. Sign in as a non-owner who has permission to manage roles but lacks, say, billing permissions. Try to give Test role a permission that person does not have.
Expected result: The matrix shows each role against each permission. The change you saved shows on both the matrix and the Roles tab. The Owner column is locked. A person cannot grant a permission they do not hold.
Report if: Owner can be edited; the matrix and the Roles tab disagree; a person can grant what they lack.

### 2.11 Integrations settings
Needs: A browser and an Owner login. A Slack, Teams or Discord incoming webhook address if you want to test the webhook.
Steps:
1. Open Administration > Advanced > Integrations.
2. Check there is a card for each real integration (email, support mailbox, single sign-on, Stripe, Freshdesk import, client portal, alert notifications, webhooks, API tokens, remote console relay, backup storage). Confirm there are no Slack, Jira or ServiceNow toggles.
3. On each card check the state (on, off, not set up) matches reality. For example, if the support mailbox is not turned on under Administration > Communications > Support Mailbox it must not show as on.
4. Click the link on a few cards and confirm it opens the right setup screen.
5. Under "Outbound webhooks" add one: a Name (for example "Ops chat"), an Address, and "Events to send". Choose the message format (Slack, Teams or Discord message).
6. Trigger an event (for example create a ticket) and read the delivery list (When, Event, Result, Attempts).
Expected result: Each card tells the truth and links to the right place. The webhook receives the message and shows a Result.
Report if: A card shows the wrong state; a link goes to the wrong page; a webhook delivery shows failure with a correct address or nothing arrives at all.

### 2.12 Custom fields
Needs: A browser, an Owner login, at least one customer and one ticket template. A portal login if you test "Customer sees it".
Steps:
1. Open Administration > Advanced > Custom Fields (heading "Custom fields"). Use the selector "What the fields are for" to choose Tickets.
2. Add a field of each type: text, number, date, dropdown (put choices one per line under "Choices (one per line)"), yes/no, link. Mark one "Required" and tick "Visible to the customer" on another.
3. Switch the selector to Customers and add a text field.
4. Open Service desk > Tickets > New ticket form. Fill in the fields. Try to create the ticket without filling the required one.
5. Open the ticket and change one custom field. Then look at Ticket History.
6. On the Tickets list use "Filter by a custom field", and type a value in "Search tickets".
7. Press "Export tickets" and check the new columns.
8. Open Business > Reports and look for a Tickets report that includes the fields.
9. Open a customer (Customers menu > the customer > Custom fields section) and fill the customer field in. Then use the customer search for that value.
10. In the portal, open the ticket as the customer and check the "Visible to the customer" field appears and the others do not.
11. Archive a field with "Archive" and check it is gone from the form; use "Restore" to bring it back.
Expected result: Fields appear where the notes say, a missing required field blocks a manually created ticket, and the history records the change. Tickets created by alerts, email or the portal are not blocked.
Report if: A field is missing from the form, list filter, export or report; a required field does not block creating the ticket; history does not show the change; the customer sees a field not marked visible.

### 2.13 Templates
Needs: A browser, an Owner login, and a mailbox you can read for the test sends.
Steps:
1. Open Administration > Communications > Templates. Use the "Kind of template" switch (Emails / ticket templates) to start with ticket templates.
2. Add a ticket template: Name ("For example: New starter"), Subject, "Description of the ticket", Priority and one custom field value. Save.
3. Open Service desk > Tickets > New ticket, use "Start from a template", pick it and check the subject, description, priority and field fill in.
4. Go back to Templates and choose Emails. Open "portal invitation", change the text, use "Preview with sample values", then type your address into "Send a test to" and press "Send test".
5. Press "Use built-in wording" to reset. Repeat the preview and test send for "portal password reset", the alert notification and the invoice email.
6. Confirm canned responses are still under Administration > Advanced > Ticketing (the page points to "Ticketing tab").
Expected result: A template pre-fills the new ticket. Each system email shows a preview with variables filled in, the test email arrives with your edited wording, and reset brings back the original.
Report if: The new ticket form ignores a template field; a test email never arrives or shows raw variables such as {{name}}; reset does not restore the original.

### 2.14 Import and export
Needs: A browser, an Owner login, Excel or a text editor. Use a test database or a test customer only.
Steps:
1. Open Administration > Advanced > Import / Export.
2. In the "Export" section export customers, then sites, contacts, devices, users, tickets, one at a time. Open each CSV.
3. In "Import from a CSV file" pick "What to import" = customers and press "Download a template". Fill in two new customers and one that already exists.
4. Choose the file under "CSV file to import" and read the preview. Check the "When a row matches something already there" choice before you confirm.
5. Confirm the import and check the Customers page. Repeat for sites and contacts.
6. If you have a customer-limited staff user, export as that user and check only their customers appear.
Expected result: Exports open with the right columns and rows. The preview lists each row's result (Line, Record, Note) before anything is saved; nothing is written until you confirm. Existing rows are handled as you chose. Limited users only get their customers.
Report if: Exports are empty or cut off; the preview says OK but the import does something else; duplicates are created against your choice; a limited user sees other customers' data.

### 2.15 Feature flags, System, Migrations, Compliance
Needs: A browser and an Owner login.
Steps:
1. Open Administration > Advanced > Feature Flags. You should see two switches: Demo data and Freshdesk import. Turn "Demo data" off, then check that "Demo data" disappears from Administration > Advanced. Turn it back on.
2. Open Administration > Infrastructure > System and read the Server, Database, Disk and Agents boxes. Press "See the list" and "Diagnostics" links.
3. Open Administration > Infrastructure > Database Migrations. Check counts: Applied, None waiting, None failed.
4. Open Administration > Advanced > Compliance and read it.
Expected result: Flags change what menus show and can be reversed. System and Migrations are read-only and show believable real numbers. Compliance is described as a posture page, not an audit or a certification.
Report if: A flag does not change the menu; numbers on System are obviously wrong (zero devices when you have some, wrong disk size); Compliance claims a certification or framework such as SOC 2.

### 3.0 Tickets, replies, notes, attachments, links, canned responses
Needs: A browser, a staff login, a customer, and a few test devices or none. A portal login or a mailbox helps for the reply test.
Steps:
1. Open Service desk > Tickets. Press the new ticket button, enter a "Ticket title" and "Description (optional)", choose a customer, press "Create ticket".
2. Open the ticket. On the "Ticket Details" side set status, priority and assignee. Check each change appears in "Ticket History".
3. Add a public reply and then an internal note (the note shows "Not sent to the customer"). Check the difference.
4. Press "Add file" and attach a small image and a PDF. Open them again from the ticket.
5. Use "Link a ticket" to link a second ticket and check it appears under "Linked tickets" on both.
6. Insert a canned response while replying (canned responses are managed under Administration > Advanced > Ticketing).
7. Use "Time worked" to log 15 minutes.
8. Back on the Tickets list use the status and priority filters and "Search tickets".
Expected result: Each action works, shows in the history, and the internal note is never visible to the customer. Attachments download intact.
Report if: Any step errors; an internal note shows up for the customer; an attachment is corrupted or missing; history misses an action. This row needs a full run-through in real use, so report anything awkward, slow or confusing as well.

### 3.1 SLAs: targets, timers, escalation
Needs: A browser, an Owner login, a customer, patience (the check runs every minute). Policies are set up as in 2.4.
Steps:
1. Open Administration > Advanced > SLA. Create a calendar for your time zone, then a policy with a very short "First reply within" (for example 2 minutes) and "Warn at" 50 percent. Under escalation choose notify people, and "Reassign to" a test person. Make it the default policy.
2. Create a ticket for a customer on this policy (Service desk > Tickets).
3. Open the ticket and read the countdown in the SLA box ("First response", "Resolution").
4. Wait until the warning time. Check the "Ticket SLA warning" notification and then the "Ticket SLA breached" one.
5. Check priority and assignee changed if you set those actions.
6. Set the ticket to a waiting-on-customer status and confirm the clock stops (policy option "Stop the clocks while the ticket is").
7. On the Tickets list use the SLA filters and sort. Open Business > Reports for "Tickets and SLA".
8. Press "Check now" on the SLA page.
Expected result: Countdowns run, the warning and breach each fire exactly once, escalation happens, and the clock stops while waiting on the customer.
Report if: A warning or breach fires twice or never; the clock keeps running while waiting; the report disagrees with what you saw on the tickets.

### 3.2 Email to ticket, and replies by email
Needs: A mailbox dedicated to testing (Microsoft 365 account with an app registration, or an IMAP mailbox), plus a second personal email address to send from. Setup needs admin access to Microsoft 365 if used.
Steps:
1. Open Administration > Communications > Support Mailbox (heading "Tickets (support mailbox)").
2. Under "How mail is read" choose Microsoft 365 (fill in Directory (tenant) ID, Application (client) ID, Client secret) or IMAP login. Follow the on-screen permissions (Mail.Send, IMAP.AccessAsUser.All). Press "Turn on" and "Save".
3. From your personal address send an email to that mailbox with a subject and a small attachment.
4. Wait a few minutes, open Service desk > Tickets and find the new ticket.
5. Reply to it as staff. Check your personal inbox gets the reply, and the From address and subject look right.
6. Reply to that email and check your reply is added to the same ticket, not a new one.
7. Open a ticket in the client portal as a customer (see 5.2), then reply as staff; the email should go to that portal person first.
Expected result: Email becomes a ticket with its attachment; staff replies arrive by email; your answer to them lands on the same ticket.
Report if: No ticket appears after 10 minutes; the replies create duplicate tickets; replies go to the wrong person; sign-in to Microsoft 365 or IMAP fails. Include the exact error shown on the Support Mailbox page.

### 3.3 Queues, assignment and routing rules
Needs: A browser, an Owner login, at least three staff users, two customers. A customer-limited staff user for the last step.
Steps:
1. Open Administration > Advanced > Queues & routing and add a queue ("For example: Printer problems"). Under "New tickets in this queue" choose "People who take turns" (round robin) and pick two people with "Add a person to the turns".
2. Under routing rules add a rule: "Comes from" email, a word to look for such as "printer", "Put it in the queue" Printer problems. Add another rule on a customer or a sender domain.
3. Use "Try a ticket" with a sample (subject "Printer on the second floor is jammed") and read what it says would happen.
4. Create three tickets with "printer" in the subject and check they alternate between the two people.
5. Open Service desk > Tickets and use the "My tickets" and "Unassigned" views. Check the counts.
6. Sign in as a customer-limited staff user and check they only see their customers' tickets or tickets assigned to them.
Expected result: The preview matches what really happens. Tickets are put in the right queue and alternate between the people. Counts match. Limited staff see only their own scope. Imported and demo tickets are intentionally not routed.
Report if: The preview says one thing and the ticket goes elsewhere; the same person gets every ticket; a limited user sees someone else's customer tickets.

### 3.4 Contacts for each customer
Needs: A browser, a staff login, a customer with a contact whose email you can read.
Steps:
1. Open Customers and open the customer. In the People section make sure a contact exists with your test email.
2. Open Service desk > Tickets > new ticket. Pick the customer and press "Who asked" to search and choose the contact. Try adding a new contact inline. Create the ticket.
3. On the ticket check the "Requester" line shows the contact.
4. Reply as staff and check the reply arrives at the contact's email.
5. Send an email from the contact's address to the support mailbox (3.2) and check it attaches to that contact.
6. In the Tickets list use the contact filter ("Their tickets"), then press "Clear the contact filter".
Expected result: The contact appears as requester, receives replies (portal person first if there is one), and inbound mail attaches to them. There are no CC contacts and no separate contact page by design.
Report if: The requester is wrong or blank; replies go to the wrong address; mail from the contact lands on no contact.

### 3.5 Ticket from a device, and devices on a ticket
Needs: A browser, a staff login, a customer with more than 25 devices if possible (or several test devices).
Steps:
1. On a ticket, open the devices card and search for a device by name using the device picker. Link two devices. Mark one "Main". Remove one with "Remove from this ticket".
2. If a customer has more than 25 devices, check you can find the 26th by typing its name.
3. Open Devices, open a device, and use "Create ticket". Do the same from a row action in the device list.
4. On the device page find the tickets card ("All tickets", "No ticket has been opened for this device.") and check it lists the ticket.
5. In Service desk > Tickets use "Tickets for a device" and the filter "Show only the tickets that have a device on them". Search by the device name.
6. Create an alert-based ticket or a removal request and check its device is already on the ticket.
Expected result: Devices link, unlink and are searchable; tickets created from a device have it on them; the device page lists its tickets.
Report if: The picker cannot find a device that exists; a ticket from a device lacks it; the device page misses a ticket.

### 3.6 Ticket templates and recurring tickets
Needs: A browser, an Owner login, a customer, a ticket template (see 2.13).
Steps:
1. Open Administration > Advanced > Recurring tickets. Add a schedule: Name, Customer, "From the template" a template, Repeats ("Every day", "Every week", "Every month", "Every year"), Start date, Time zone and time, End date.
2. Look at the preview of upcoming dates.
3. Choose "Skips while the last one is open", then press "Run now". Press "Run now" again with the first ticket still open.
4. Pause the schedule, check "Paused", then resume it.
5. Open the history ("Last run", "Result", "Ticket or reason").
6. Try setting an end date before the start date.
Expected result: Run now creates one ticket. The second run is skipped with a reason while the first is open. Pausing stops runs. An impossible date range says "It never runs with these dates." A failed run is recorded and not retried.
Report if: Duplicate tickets are created; a paused schedule still runs; the preview dates are wrong for the time zone chosen. Restart safety (no duplicates after a server restart) needs a developer.

### 3.7 Technician schedule and dispatch board
Needs: A browser, a staff login, at least two technicians, an email address for the invite, a mouse. Also a phone for the phone-width check.
Steps:
1. Open Service desk > Calendar. Press "Hours and time off", choose a technician, set working hours, press "Save working hours", then under "Time off" add a day with a reason.
2. Press "New visit". Choose a ticket, technicians, the time and "Length", "Where", "Notes for the technician". Save.
3. Switch between day and week view, use Previous, Today and Next, and switch the people filter between "Scheduled people" and "Everyone".
4. Create a second visit for the same technician at an overlapping time. Look for the "This clashes" warning.
5. Check the "Needs a visit" list and press "Schedule" on a ticket.
6. DRAG a visit to another time and to another technician with the mouse (never tried before). Check it moved and stayed after reload.
7. Open a visit: change status ("En route", "On site"), and use "Log the time on the ticket".
8. Check the technician's email for the calendar invite (.ics file) and the customer's email if you chose to notify them. Open the .ics in Outlook or Google Calendar.
9. Open the Calendar on a phone and use it.
Expected result: Visits show on the right day and technician, clashes warn, dragging reschedules and persists, invites open in a calendar app.
Report if: Dragging does nothing, drops in the wrong slot or does not save; invites do not arrive or show wrong times or time zone; the layout is cut off or unusable at phone width.

### 3.8 Customer satisfaction surveys
Needs: A browser, an Owner login, a customer contact with a mailbox you can read, a ticket you can close. The screens were only checked by code tests, so look hard at how they look and behave.
Steps:
1. Open Administration > Communications > Surveys. Turn on "Send surveys", set "Ask when a ticket is" Resolved or Closed, "Send after", "Ask each person at most once every (days)", "The link works for (days)", the rating type (Five stars or Thumbs up or down), and a reminder. Save.
2. Close a ticket whose requester is your test contact.
3. Open the email and click the survey link without signing in. Answer "How did we do?" and add a comment.
4. Click the same link again.
5. Close another ticket for the same person immediately (it should be throttled).
6. Return to the Surveys tab and read the response rate, average, scores, "By customer", "By technician", "Recent comments".
7. Give a low score and check that "Low scores" alerts the people you chose under "Tell these people".
8. On the ticket check the "Customer survey" card.
9. In the portal check the survey shows there too.
Expected result: One email per ticket; the link works once ("Thank you for your feedback."), then says it is used or closed; throttling stops repeat asks; the stats match your answers; low scores alert.
Report if: Any screen looks broken or misaligned; the link works twice or needs sign-in; the stats are wrong; no low-score alert.

### 3.9 Internal knowledge base
Needs: A browser and a staff login. A portal login for the customer-visible part.
Steps:
1. Open Service desk > Knowledge base. Press "New article". Write a title and Markdown content (headings, lists, links), add tags and a category (the "Categories" button lets you add one). Save as a draft.
2. Search it with "Search articles". Change status to published. Edit again, then open version history and restore the first version.
3. Open a ticket and check the suggested articles and the link box. Link your article to the ticket.
4. Vote the article useful or not useful.
5. Mark one article as visible to customers and open the customer portal's Knowledge area to check it shows (and a staff-only one does not).
6. Try to insert an image (it is not supported by design).
Expected result: Drafts do not show in search for others or in the portal; history and restore work; suggestions are relevant; only customer-visible articles show in the portal.
Report if: A draft shows publicly; restore loses text; search cannot find a word that is in the article; a staff-only article is visible in the portal.

### 4.1 Time tracking on tickets
Needs: A browser and a staff login with a ticket.
Steps:
1. Open a ticket. In the "Time worked" card start the timer, wait 2 minutes, stop it.
2. Use "Add time by hand": enter "1:30" in "Time spent", a "Date worked", "What was done", and choose Billable or not.
3. Try the other formats: "25", "1h 30m".
4. Look at the totals and at the status badges ("To approve", "Approved", "Invoiced").
5. Delete one entry using its delete button.
6. Open Business > Billing > Time and check the same entries are there.
Expected result: Entered times add up correctly and show on the Billing Time tab with the right customer, billable setting and person.
Report if: Totals are wrong (for example 1:30 becoming 1 hour 3 minutes); the running timer is lost on reload; an entry vanishes or appears twice.

### 4.2 Timesheets and approval
Needs: A browser, two staff users (one logs time, one with permission to approve).
Steps:
1. As the first user log time on a ticket.
2. As the approver open Business > Billing > Time. Use "Filter by status" with "Waiting for approval".
3. Tick entries (or "Select all") and press "Approve N". Try "Send back" on another.
4. As the first user try to edit or delete an approved entry.
5. Filter by "Approved" and "All".
Expected result: Approved time is locked to its owner (cannot be edited or deleted by them); sent-back time can be changed.
Report if: Approved time can still be edited by its owner; Send back has no effect; the approver cannot see the entries.

### 4.3 Service catalog and price lists
Needs: A browser and a staff login with billing access.
Steps:
1. Open Business > Billing > Catalog. Add an item: "Item or service" "Remote support hour", "Price" 95.00.
2. Untick "Available" for one item and re-tick it.
3. Open Billing > Invoices > "New invoice", choose a customer, and from "Add from catalog" pick your item.
4. Check the line description and price copied across. Save the draft.
5. Delete a catalog item and check existing invoices keep their lines.
Expected result: The item adds to the invoice in one click with the right price; unavailable items cannot be added.
Report if: The price differs from the catalog; an unavailable item is still offered; deleting an item changes old invoices.

### 4.4 Contracts: per device, per user, block hours, flat rate
Needs: A browser, a staff login with billing access, a customer with devices that have the agent.
Steps:
1. Open Business > Billing > Contracts and press "New contract".
2. Create one of each type: "Flat fee" (Price per period), "Per device" (Price per device), "Per user" (Price per user, Users covered), "Block of hours" (Price of the block, Hours included, Rate for extra hours), "Hourly" (Hourly rate). Set Billed (Monthly, Quarterly, Twice a year, Yearly), Starts, and optionally Ends.
3. Check the "Next invoice" column, then use Pause (status "Paused") and resume.
4. Check the next day or after the next invoice date that a draft invoice was made (Billing > Invoices, draft). Check exactly one draft per period.
5. For a block contract log billable time beyond the included hours and check the overage appears.
Expected result: Each type prices correctly; one draft per period only.
Report if: A draft is missing or duplicated; the amount is wrong (check by hand); the overage is wrong. Waiting for the schedule to run may need a developer to trigger it.

### 4.5 Device and user counts feeding recurring billing
Needs: A browser, a billing staff login, a customer with agent devices.
Steps:
1. Count the customer's devices that have an agent (Devices page, filtered to the customer).
2. Create a "Per device" contract for that customer at a clear price (for example 10.00 per device).
3. On billing day (or when a developer triggers the run) open the draft invoice.
4. Check the quantity equals your device count. Remove or add a device and run again to see the change.
5. For a "Per user" contract confirm you type "Users covered" in by hand.
Expected result: The device count on the draft equals the number of devices with agents at the time; per-user is manual.
Report if: The count is off by any number; deleted or offline devices are counted wrongly.

### 4.6 Invoices and PDFs
Needs: A browser, a billing staff login, a mailbox you can read (email has not been tried for real).
Steps:
1. Open Business > Billing > Invoices, press "New invoice", choose a customer, add lines and "Notes for the customer", press "Save draft".
2. Open it and check Subtotal, tax and Total by hand.
3. Issue it (the invoice gets a number), then press the PDF button and open the PDF.
4. In "Send to" enter your address and send. Check the email, its PDF attachment and its wording (these can be edited at Administration > Communications > Templates).
5. Record a payment: Amount, Method (Check, Transfer, Card, Cash, Other), Reference. Check Paid and Balance change.
6. Remove the payment with "Remove payment", then void the invoice.
Expected result: Numbers, tax and totals are right; PDF looks professional; email arrives with the PDF; payments change the balance.
Report if: Totals or tax are wrong; the PDF is cut off or blank; the email never arrives or lacks the PDF; the numbering skips or repeats.

### 4.7 Online payments (Stripe or similar)
Needs: Your own Stripe account in test mode (publishable key, secret key, webhook secret) and a Stripe test card number. This has never run against real Stripe.
Steps:
1. Open Administration > Billing > Billing (if the tab is hidden, ask a developer) and enter the Stripe keys, or follow the card shown under Administration > Advanced > Integrations.
2. Create an invoice for a test customer and issue it, then open its customer-facing payment link (the portal invoice, see 5.4).
3. Pay with Stripe's test card 4242 4242 4242 4242, any future expiry and any CVC.
4. Return to the invoice and check it shows as paid.
5. Repeat with a declining test card and cancel halfway.
Expected result: The invoice becomes paid after Stripe confirms, with the payment recorded once. A declined or cancelled payment leaves it unpaid.
Report if: Payment succeeds at Stripe but the invoice stays unpaid; it is marked paid twice; an error page appears at return. This needs a developer to set up the webhook address in Stripe.

### 4.9 Quotes and proposals
Needs: A browser, a billing staff login, a mailbox for the customer.
Steps:
1. Open Business > Billing > Quotes, press "New quote", choose a customer, add lines, save and send to your address.
2. Open the link from the email without signing in and press accept. Repeat with another quote and decline.
3. Back in the console check the status of each.
4. On the accepted quote convert it to an invoice. Check the numbers match and that the invoice has its own number.
Expected result: Quotes have their own number series; the customer's choice shows in the console; conversion keeps lines and totals.
Report if: The link does not work or asks for sign-in; the status does not change; converting changes a price.

### 4.10 Profitability per customer
Needs: A browser and a billing staff login with some invoices and time logged.
Steps:
1. Open Business > Billing > Reports.
2. Set the "From" date (and the end date) to cover your test data.
3. For one customer work out by hand: invoiced before tax, outstanding balance, hours, labor cost and margin (invoiced minus labor).
4. Compare with the row on screen: Invoiced (before tax), Outstanding, Hours, Labor cost, Margin, and the Total row.
Expected result: Each figure matches your calculation; the Total row equals the sum.
Report if: Any figure differs, tax is counted as revenue, or a customer is missing.

### 5.1 Client sign-in, separate from technicians
Needs: A browser (use a private window), a customer contact with a mailbox, and a staff login. The portal address is set under Administration > Advanced > Client Portal.
Steps:
1. Open Administration > Advanced > Client Portal. Set the "Portal domain" address, press "Check address", turn "Portal is on" and save. (DNS and proxy setup in the page may need a developer.)
2. Open Customers > the customer > give a person access using "Give someone portal access". Choose role Manager or User and tick "Email an invitation now".
3. Open the invitation email, set a password, then sign in at the portal address with Email and Password.
4. Use the forgot-password link and finish the reset.
5. Enter the wrong password several times and check the account locks.
6. While signed in to the portal, try to open the staff console addresses (console.example.com). Then try to sign in to the portal with a staff login.
Expected result: Invitation, sign-in, reset and lockout all work; a staff login does not work at the portal and a portal login cannot open staff pages.
Report if: A staff login works on the portal (or the reverse); an invitation or reset email does not arrive; no lockout happens.

### 5.2 View and open tickets
Needs: A portal login (see 5.1) and a staff login in another browser.
Steps:
1. Sign in to the portal. On the home page see "Recent tickets". Open "Tickets" and use "Search tickets" and "Which tickets".
2. Press "New ticket", enter a title and description and send it.
3. As staff, open that ticket in Service desk > Tickets and reply publicly.
4. Back in the portal check the "New reply" marker on the list. Open the ticket and reply.
5. Check the staff reply also arrived by email, and your portal reply shows on the staff ticket.
Expected result: The portal person sees only their company's tickets; the marker appears and clears after opening; replies work both ways and are emailed.
Report if: You see another customer's tickets; the marker never appears or never clears; internal notes show in the portal.

### 5.3 View devices and health
Needs: A portal login whose customer has devices with agents.
Steps:
1. Sign in to the portal and open "Devices". Use "Search devices".
2. Open a device and read its health (online state, problems).
3. Compare with the same device in the staff console.
4. Sign in as a customer whose portal access excludes devices (set under Administration > Advanced > Client Portal, "What customers can open") and check you see "This area is not available to you."
Expected result: Only this customer's devices show, with health matching the staff view; the hidden area is refused.
Report if: Another customer's device appears; the health differs from staff view; the hidden area is still reachable.

### 5.4 View and pay invoices
Needs: A portal login and an issued invoice for that customer. Paying also needs Stripe (4.7).
Steps:
1. Sign in to the portal and open "Invoices". Check the list columns (Invoice, Issued, Status, Total, Balance).
2. Open one invoice and check its numbers against the staff console.
3. Open "Reports" in the portal and press "Download PDF" on one.
4. Only if Stripe is set up: press pay and use the Stripe test card (see 4.7).
Expected result: Only this customer's invoices show and match the console; PDFs download; payment works only with Stripe set up.
Report if: Wrong amounts; another customer's invoice; PDF will not download.

### 5.5 Device tray app: request help, chat, see status
Needs: A Windows PC with the new agent (1.3.39 or later, in the candidate slot, so the PC must be in the test ring; ask the developer), signed in as a normal user, plus a second person account on the same PC if possible, and a Slack or Teams webhook (optional).
Steps:
1. As an Owner open Administration > Infrastructure > Agents and find the "Tray app (Windows)" box. Turn on "Show the tray app on devices", "Let people ask for help", "Let people chat with support". Fill in "IT provider name", support email, support phone, "Office hours" and "Point of contact". Save.
2. On the PC wait about a minute and look next to the clock for the ADG RMM icon (this was never checked by a person). Note if a second icon appears.
3. Click the icon and read the status window: connected, problems found, its own help requests, and the support phone and email.
4. Ask for help (try "urgent" and "not urgent"). Then in the console open Service desk > Tickets and check a ticket exists for the computer's customer with the PC on it.
5. Chat: type a message in the tray and open Service desk > Device chat in the console. Reply. Check unread counts, "delivered" and "seen" markers on both sides. If a webhook is set, check the message also reached Slack or Teams.
6. Sign in as a second person on the same PC (or use fast user switching) and check they get their own tray and can not see the first person's items.
7. Run the tray as a non-administrator account.
8. Turn "Show the tray app on devices" off again and check the icon disappears within a minute or two.
Expected result: The icon appears for each signed-in person, works for a standard user, tickets and chat flow both ways, and it closes when switched off. Until it is switched on, the PC learns nothing about the tray.
Report if: No icon appears after 5 minutes (a likely sign the agent could not start it in a user session); the tray works only for administrators; a second person sees someone else's tray; messages are lost or not marked seen; the icon stays after turning it off. Linux and macOS have no tray, which is expected.

### 5.6 Client branding
Needs: A browser, a staff login, a portal login for the customer, and a logo image.
Steps:
1. Open Customers, open the customer and go to the "Branding" section of the customer form.
2. Set a colour, cover text, footer text and upload a logo. Save.
3. Sign in to the portal as that customer and check how it looks, and open a portal report PDF (Reports > Download PDF).
4. Remove the logo ("remove logo") and check the portal falls back.
5. Note that a separate portal logo and portal colours are NOT built yet; do not report their absence.
Expected result: The customer's colour, logo, cover and footer show on the portal and its reports.
Report if: Branding does not appear or looks broken (stretched logo, unreadable colours); removing the logo does not remove it.

### 6.3 Asset records, filled in from agents
Needs: A browser, a staff login, a customer with devices that have the agent. A customer-limited staff user for the limit check.
Steps:
1. Open Devices > Assets (top menu Devices group).
2. Check that each device with an agent has a record. Use "Search assets" (name, serial number or model), the Customer selector and the Type selector. Open the "Ending within 90 days" view.
3. Press "Update from agents now" and check the records refresh.
4. Press "Add an asset", fill in Name, Customer, Type, Maker, Model, Serial number, Purchased, Ends, Location and Notes, and save. Then Edit and Delete it.
5. Try to delete a device's own record (should be refused).
6. Click a Network discovery or SNMP link at the top.
7. Sign in as a customer-limited staff user and check they see only their customers' assets.
8. If assets are switched to an external system (see 6.7) the page should say where assets are managed.
Expected result: Records match the real devices, filters work, manual assets can be added, edited and deleted, a device's own record cannot be deleted, limited users see only their customers.
Report if: A device is missing or has wrong details; a limited user sees all customers; the "Update from agents now" button errors.

### 6.4 Non-agent assets: network gear, printers, licences
Needs: A browser and a staff login.
Steps:
1. Open Devices > Assets and press "Add an asset".
2. Add a printer (Type printer), a switch (network gear) and a software licence with an end date, each with a customer, serial number and Location.
3. Use the Type selector to filter to each kind, and "Search assets" for the serial number.
4. Edit each one and delete one.
5. Reload and confirm the others are still there.
Expected result: Non-agent assets can be created, searched and filtered by type, edited and deleted.
Report if: A type is missing; a saved asset disappears or loses fields; a licence end date is not shown.

### 6.5 Warranty and expiry tracking
Needs: A browser, a staff login, a mailbox that receives the expiry emails (email has not been tried for real), and a developer if you cannot wait for the 30, 7 and 1 day marks.
Steps:
1. Add assets (Devices > Assets > "Add an asset") with "Ends" set to about 30, 7 and 1 days from today, using a test customer.
2. Open the "Ending within 90 days" view and check all three show.
3. Check the mailbox set to receive warnings at the 30, 7 and 1 day marks.
4. Make sure you got one email per mark, not repeats.
Expected result: The expiring items are listed and emailed once at 30, 7 and 1 days before they end.
Report if: An item is missing from the 90-day view; emails never come or repeat daily; the dates in the email are wrong.

### 6.6 Links between tickets, devices and assets
Needs: A browser, a staff login, a ticket, a device and an asset for the same customer.
Steps:
1. Open the ticket and find the link panel (Customer and device card, and the devices card).
2. Link an asset to the ticket.
3. Click the asset link in the panel and check it opens that asset on the Devices > Assets page.
4. Open the device page and check its tickets card ("All tickets") lists the ticket.
5. There is no link to documents or passwords (removed on purpose).
Expected result: Links work in both directions and open the right records.
Report if: A link opens the wrong asset or a not-found page; the ticket does not appear on the device.

### 6.7 Asset manager provider: built-in or external
Needs: A browser and an Owner login (it needs the right integrations.manage). Do it on a test setup, not your real data. No Killian connector exists yet, so you only test the switch itself.
Steps:
1. Open Administration > Advanced > Integrations and find the assets card.
2. Choose "Manage assets somewhere else", type the provider name ("Killian") and address in the fields. Read the preview of what changes ("This stops" and "This keeps").
3. Press "Export CSV" and "Export JSON" and open both files.
4. Confirm the switch (you are asked to confirm).
5. Open Devices > Assets, which should now say where assets are managed. Check hourly fill-in from agents and the expiry emails have stopped, and reports fall back to firmware dates.
6. Check Administration > Advanced > Audit Logs for the switch.
7. Use "Switch back to the built-in asset manager" and check everything returns, with nothing deleted.
8. As a non-owner try to open the card.
Expected result: The preview is accurate, exports contain all assets, switching off and on loses nothing and is audited, and non-owners cannot switch.
Report if: Assets are deleted or missing after switching back; the exports are empty; a non-owner can switch; the Assets page still lists built-in assets while switched off.

### 7.2 Customer health reports
Needs: A console login with reports rights; at least one customer with enrolled devices that have been online for a few days (so there are checks and alerts to count); a PDF viewer.
Steps:
1. Open https://console.example.com and sign in.
2. In the top bar open Business > Reports.
3. In the left list open the group Customers and click "Customer summary".
4. Choose a customer that has real devices.
5. Read the numbers shown: Devices, Online now, Checks passed, Alerts raised, Critical alerts, Average time to resolve.
6. Click "Download PDF" and open the file.
7. Compare the numbers with what you see on the customer's Devices list and on Monitoring > Alerts (count the devices, and count the alerts in the same period).
Expected result: The page and the PDF show the same numbers. Devices equals the real number of devices for that customer; Online now matches what the device list shows as online. "Checks passed" shows a percentage (or "No runs" only if no checks ever ran). The PDF opens, carries the customer's name and is readable.
Report if: A number is clearly wrong (0 devices for a customer that has devices, alerts that do not exist), the page shows an error, the PDF will not download or is blank/cut off, or the PDF and the page disagree.

### 7.3 Scheduled and emailed reports
Needs: A console login; a customer; a real mailbox you can read (the address you type as recipient); the server must be able to send mail (Administration > SMTP already working).
Steps:
1. Business > Reports. In the left list open the group Customers and click "Scheduled".
2. Under "Report" choose "Customer summary". Choose a customer.
3. Set the timing to a time a few minutes from now (see 7.11 for the timing choices), choose the format "PDF", and in the "To" box type your own email address.
4. Click "Schedule".
5. In the list "Scheduled reports" find your row and click "Send now" at the end of the row.
6. Check your mailbox (also the spam folder) within a few minutes.
7. Wait for the time you set and check that a second email arrives on its own.
Expected result: The email arrives from the server's configured sender, with the PDF attached, the customer's name in the subject or body, and the PDF opens. The "Last result" column of the row shows a success. The scheduled send arrives at the set time.
Report if: No email arrives, the email arrives without the PDF or with an empty/corrupt one, "Last result" shows an error, the scheduled send never comes or comes at the wrong time, or it arrives twice.

### 7.4 Technician and SLA performance
Needs: Console login; a desk with tickets that have SLA policies and some time entries (ideally several technicians); a few weeks of ticket data.
Steps:
1. In the top bar open Service desk > Performance.
2. Under "Period" choose 7, then 30, then 90 days.
3. Read the cards: Tickets, Resolved, Open, Response met, Resolution met, Avg response, Avg resolve, Logged. Compare Tickets and Resolved for the team with the ticket list filtered to the same period.
4. In the Technician table compare one technician's numbers with their tickets and time entries.
5. Check the "By priority" table.
6. Use the customer filter (the customer selector at the top) and confirm numbers change.
7. Open a ticket with no SLA policy and confirm it is left out of the percentages (see SLA settings).
Expected result: Counts match the real tickets; percentages are only from tickets that have a policy; time logged equals the time entries; the filter narrows all numbers.
Report if: Counts differ from the ticket list, a percentage above 100 or negative, average times that are obviously wrong (for example negative or zero when tickets exist), a technician missing or a customer filter that has no effect.

### 7.5 Workflow builder: when this happens, do that
Needs: Console login with the right to change settings (settings.write); a test customer; at least one enrolled test device; a script in the library; a Slack or email notice target set up as for backups (optional). An alert test (a failing check) is easiest on a test device.
Steps:
1. Open Administration > Workflows.
2. Under "Start from a ready-made rule" click each of the four rules in turn (new computer onboarding, offline computer ticket, failed update ticket, critical alert) and confirm none of them is switched on (shows Off until you save and tick "On").
3. Create your own rule: name it (placeholder "Critical alert on a server opens a ticket"), pick the trigger "an alert is raised", add a condition (for example severity is critical) under "Only if (all of these)", and under "Then do (in this order)" add: create a ticket, set priority, assign to a technician, send a notice.
4. Click Save, then tick "On" and save again.
5. Click "Try" on the rule: it shows what would happen on the newest real event without running anything.
6. Cause a real alert on the test device (for example stop a monitored service or fill a test condition) and check Tickets for the new ticket, with the priority and technician set, and the notice arrives.
7. Cause the same alert again within the cool-down; no second ticket should appear.
8. Add a "run a script" action and check the script runs on the device and appears in its history.
9. Check a ticket created by the workflow does not start another workflow.
10. Sign in as a user with only read rights and check they can see the rules but not change them.
Expected result: Rules are off until you switch them on; "Try" shows a preview with no side effects; real events produce the actions in order; cool-down, the 30 runs an hour cap and the failed-step rule hold.
Report if: A rule runs while Off, a duplicate ticket inside the cool-down, a ticket made by a workflow triggers another one, "Try" actually creates a ticket or runs a script, a read-only user can change a rule, the page errors or looks broken in the browser. This feature has not been seen with a real alert or in a browser yet, so note any layout problems too.

### 7.6 Self-healing: run a script when a check fails
Needs: A Windows test PC with the agent (a VM you may break safely) and optionally a Linux VM with the agent; console login with settings access; the developer's script agents/tools/simulate-issue.ps1 (ask the developer for it) which makes a safe fault on Windows.
Steps:
1. Open Monitoring > Automatic repair and click "Settings" (or Administration > the Automatic repair card).
2. Switch on "Self-healing: repair a failed monitoring check without waiting for a ticket" and "Repair the problems that have a safe repair". Save.
3. On the test PC make sure a check exists for the Spooler service (also try DNS client, Windows Time, disk, CPU, ping) through the device's "Checks & Alerts" tab or a policy.
4. Stop the Spooler service on the PC (or run simulate-issue.ps1 as the developer instructs).
5. Wait for the check to fail and an alert to appear (Monitoring > Alerts).
6. Open Monitoring > Automatic repair and look under "Recent runs": a run should appear for that computer and no ticket should be created.
7. Confirm the service is running again on the PC and the alert resolves by itself.
8. Click a run to open its log.
9. Check the results report: "Fixed", "Handed over" (with reasons), "Technician time saved", "What to add next".
10. On a Linux VM, fill the disk or stop a service the repair knows about and repeat.
Expected result: The fault is repaired without a ticket, the alert resolves after confirmation, the run has its own log, and the report counts it. If a repair cannot be done it is "handed over" with a reason.
Report if: Service still stopped after the repair, the alert never resolves, a ticket is created though none should be, repair runs repeatedly in a loop, the PC is changed in a way you did not expect, or the report counts do not match the runs list. Real repairs on a broken computer are the unproven part; do this only on a test machine.

### 7.7 New device onboarding automation
Needs: Console login with settings access; a test customer; a spare Windows or Linux machine to enrol (or a VM).
Steps:
1. Administration > Workflows.
2. Under "Start from a ready-made rule" click "New computer: open an onboarding ticket". The form opens with the trigger "a computer enrolls".
3. Add one more action (a notice, and a script from the library). Click Save and tick "On".
4. Enrol a new machine with the agent installer (an install key from Administration > Install keys).
5. Check Service desk > Tickets for the onboarding ticket and check the notice and script ran.
6. Enrol the same machine again within the cool-down and check no second ticket.
Expected result: Nothing is active until you saved and switched it on; after enrolling, one onboarding ticket with the right subject and the extra steps run once.
Report if: The rule is already on when you open it, no ticket after enrolling, two tickets for one machine, or an extra step does not run.

### 7.8 Endpoint reports and the report workbench
Needs: A console login; a fleet with real devices (ideally some Windows devices with agent data for a day); Excel to open the CSV; a PDF viewer. The workbench (filters, saved views, charts) is committed but not yet deployed, so ask the developer whether it is live on your test site before starting steps 5 to 12.
Steps:
1. Business > Reports. Look in the left list: groups Inventory, Lifecycle, Health, Security, Patching, Activity, Service. Open Inventory and click "Hardware inventory".
2. Check the columns (name, customer, CPU, memory, disk and so on) have real values and are not empty. Note one device you know well and compare its memory and disk with the device itself.
3. Open "Software inventory" and "Software summary" (each program and version with a device count) and check one program you know is installed on exactly two devices shows 2.
4. Open Health > "Device health". Compare the Online/Last seen of one device with the device's own page; they must match.
5. Click "Filters". Add a condition (for example the column Operating system "contains" Windows). Click Filters again to add a second group using all/any. The row count and summary line must change.
6. Click the small funnel icon on a column heading to filter by that column.
7. Click a column heading to sort; shift-add up to three sort columns.
8. Choose "Group by" a column (for example Customer); check groups show counts and can be collapsed.
9. Click "Columns" and untick two columns; click "Download CSV" and open it in Excel (accents and the first column must look right, no strange characters); the file must have only the chosen columns and only the filtered rows. Then click "Download PDF".
10. Click "Charts" and check a chart appears and changes when you filter.
11. Click a device name in the table; it must open that device.
12. Click "Saved views", type a name in "Name this view", click Save; then click "Reset view", then open your saved view again; filters, sort, grouping and columns must come back. Ask a second team member to open it and to try to change it (they must not be able to; only the owner can).
13. Repeat steps 4 and 9 with the reports Alert history and Remote sessions (Activity group).
Expected result: Every report has real data, not empty columns. Summary line, charts, CSV and PDF all follow the filter. CSV opens in Excel correctly. Saved views restore exactly and only the owner can change them.
Report if: Empty columns, wrong online/last-seen, CSV with garbled characters or unfiltered rows, a chart that ignores the filter, a saved view that restores differently, another user able to edit your view, slow page (over about 10 seconds) with your fleet size, or any error message.

### 7.9 Agent data for reports
Needs: A Windows 10/11 PC with agent 1.3.26 or newer enrolled (a PC where you can also run it as the normal service account, not a user session), and ideally a second one that is BitLocker-encrypted with a TPM. Console login.
Steps:
1. Open the device: Devices... use the dashboard or Customers to find the PC and click it.
2. Wait up to one hour after the agent update (the agent reports once an hour); check the Overview tab and the Security tab.
3. Check these facts against the PC itself: exact Windows edition and build (Settings > System > About), last start time, pending restart (install an update that wants a restart and see it shown), firmware vendor/version/date (msinfo32 > BIOS Version/Date), antivirus products and whether on, Defender real-time protection and definition age, firewall profiles, BitLocker per drive, TPM, Secure Boot, network adapters.
4. Reports > Inventory > "Hardware inventory": click "Columns" and tick the new ones (Windows edition, version and build, firmware date, age, last restart, days since restart, MAC address) and compare.
5. Patching scans: open the device's Patch tab. Within a day (the server queues a read-only scan about once a day for each online Windows device) check a scan appears without you clicking anything.
Expected result: All listed facts match the PC. BitLocker and TPM must also show real values on a device where the agent runs as the service account (the notes say they came back empty only without administrator rights). A patch scan appears by itself roughly daily.
Report if: A fact differs from the PC (wrong build, wrong firmware date, antivirus shown off when on), BitLocker/TPM empty on a PC where they exist and the agent runs as a service, the agent slows the PC or uses noticeable CPU every hour, or no automatic patch scan ever appears after 24 hours on an online device. Note: the history of scans and the software change log are not built yet; do not test them.

### 7.10 Reports on the new agent data
Needs: Console login; at least a few Windows devices with agent 1.3.26+ that have been online for a day, with at least one having antivirus off or a missing update if you can arrange it.
Steps:
1. Business > Reports > Security group > "Security status". Check antivirus, firewall and disk encryption columns per device, unprotected devices listed first, and that a device that has not reported yet is shown differently from a real problem.
2. Patching group > "Patch compliance": check each device shows one of Compliant, Missing patches, Scan overdue, Scan failed, Not scanned, with critical counts. On one PC, open its Patch tab and compare the missing updates.
3. Patching > "Missing updates": one row per update per device, most serious first. Install one of these updates on a PC, run a patch scan, and check the row disappears.
4. Patching > "Patch activity": check your install run appears with when, where, who, what, result and error.
5. Health > "Device health": check it flags a pending restart, a device not restarted for a long time (set the limit in the filters), and antivirus off or out of date.
6. On "Hardware inventory" use "Columns" to tick the new columns (hidden until chosen).
7. On any of them try "Filters", "Group by", "Charts" and "Saved views".
Expected result: The values match the real state of the PCs; the compliance state changes correctly after a scan and install; filters, grouping, charts and saved views work as in 7.8.
Report if: A compliant device shown as Missing patches (or the reverse), an installed update still listed after a new scan, a device wrongly shown unprotected, or any report that is empty when you know data exists. The executive PDF and the hardware/software change log are not built; do not report them as missing.

### 7.11 Scheduling for every report, with full control of days and times
Needs: Console login; a real mailbox for the recipient; at least one customer (ideally two customers in different time zones); about an hour for the timed tests.
Steps:
1. Business > Reports > Customers > "Scheduled".
2. Under "Report" choose "Security status" (also try a Health, Inventory and Patching report). Choose a "Saved view" or leave "No saved view (everything)". Choose a customer (or all) and optionally Site and Device.
3. Set the format to PDF, then CSV, then both, and type your address in "To". Tick "Skip when there is nothing to report" for one schedule.
4. Try each timing: every day; chosen days of the week (use the Weekdays and Every day shortcuts and a single day); every month on a day (pick 31); on the last day; the second Tuesday; and once on a date. Pick the time of day and the time zone.
5. After each choice, read the preview under "Next sends:". It must name the correct next dates in words and in the customer's time zone. Check 31 in a month with 30 days shows the last day.
6. Click "Schedule". Click "Edit" on the row, change the time, and click "Save changes"; the row must keep its history.
7. Click "Send now" on a row and check the mail arrives with the right attachment(s).
8. Create a one-off for a few minutes ahead and check it arrives once and then shows as off.
9. Check "Alert history" and "Remote sessions" cannot be chosen in the Report list.
10. If a daylight saving change is near for the customer time zone, set a time inside the changeover hour and check what the preview says.
Expected result: Previews match the calendar. Mail arrives at the local time of the customer's zone with the right format. A one-off turns itself off. Edit keeps history. Send now works. Alert and remote-session reports are not offered.
Report if: Preview dates are wrong or differ from what actually sends, mail arrives at the wrong hour, a duplicate or a missed send, the one-off stays on, the CSV or PDF is missing or empty, "Skip when there is nothing to report" sends anyway or never sends when there is data. Note the real mailbox delivery is the unproven part.

### 7.28 Customer backup report
Needs: Console login; at least two Windows or Linux computers with the agent, one with a recent real backup (or a Windows restore point) and one with nothing; Excel.
Steps:
1. In the top bar open Devices > Endpoint backups.
2. Choose a customer in the "Customer" selector (or "All customers").
3. Check the page shows how many computers are protected and a line per computer with Status, Last backup, What protects it.
4. Click "Backup report (CSV)" and open the file in Excel.
5. Compare each line of the CSV with the page.
6. In a computer's name field (rename a test computer to start with =1+1 or @cmd) re-download the CSV and look at that cell.
7. Sign in as a user limited to one customer and check the report contains only that customer's computers.
Expected result: The CSV has one line per computer matching the page, and any text starting with = + - or @ is shown as plain text, not a formula. A limited user sees only their customers.
Report if: The CSV differs from the page, Excel runs or evaluates a formula, a limited user sees another customer's computers, or the file does not download. The scheduled/emailed version is not built yet; do not test it.

### 7.31 Automatic patching report
Needs: Console login; Windows devices that have a patch policy (Policies > Patching) and ideally one with a maintenance window and one with a recent automatic install.
Steps:
1. Business > Reports. In the left list open the group Patching and click "Automatic patching".
2. Read for each Windows device: which policy patches it, whether it waits for a maintenance window, last automatic install, last restart and restarts still pending.
3. Compare two devices against their policy under Automation > Policies, and against the device's Patch tab.
4. Try "Filters", "Group by", "Download CSV" and "Download PDF".
Expected result: Every Windows device has a row with the correct policy; window/restart information matches the policy and the device.
Report if: A device is missing, the wrong policy is named, last install or pending restart is wrong, or the downloads fail or are empty.

### 8.1 Windows Defender status and control
Needs: A Windows 10/11 PC with the agent and Microsoft Defender as the antivirus (a test PC; also one with a third-party antivirus if you have it). Console login with the right to run device actions.
Steps:
1. Open the device and click the "Security" tab.
2. Click "Scan now" if the tab has not scanned yet. Read the Microsoft Defender box: service, real-time protection, tamper protection, signature age, last quick/full scan, active threats, and the other antivirus recognised.
3. Compare each item with Windows Security on the PC (Virus and threat protection).
4. Click "Update signatures" and confirm; check the signature age on the PC and in the console after a minute.
5. Click "Start quick scan", confirm; check the PC (Windows Security > scan history) and the console result.
6. Click "Start full scan", confirm; let it run, check the result.
7. On the PC, turn off real-time protection briefly (if tamper protection allows) and rescan; check the console shows it off. Turn it back on.
8. Check there is no button to turn protection off or add exclusions.
Expected result: The Defender data matches Windows Security; the three buttons start the actions on the PC and the result appears in the tab.
Report if: Any value differs from Windows Security, a button does nothing or errors, the device is wrongly shown "offline", or there is a way to disable Defender from the console. Items read as the system account (TPM, full BitLocker detail) are checked only by parser tests so compare these with extra care.

### 8.2 EDR and antivirus integrations
Needs: A real account for at least one of: Microsoft Defender for Endpoint (an Entra app with Machine.Read.All), SentinelOne (Viewer API token), Huntress (API key and secret), CrowdStrike Falcon (API client with Hosts read). Console login. Enrolled devices that the product also protects (matching serial or name).
Steps:
1. Open Monitoring > EDR and antivirus.
2. Click "Connect a console", pick the "Product", fill in the credentials, choose "Which customer is this console for?" (a customer, or "All customers (one console for everyone)") and click Connect/Save.
3. Click "Read now" (the refresh icon with that title) on the connected console and wait.
4. Read the "What the consoles say" list: each endpoint with Status (protected, warning, unhealthy), and see which computer it matched.
5. Check coverage figure, the list "No console lists this computer." (computers no console knows) and the console endpoints not managed here.
6. Compare 3 endpoints with the vendor's own console (name, threats, sensor state, last call-in).
7. Make an endpoint unhealthy in the vendor console if you can (for example no recent call-in) and read again; a warning alert should appear in Monitoring > Alerts and clear when fixed.
8. Click "Change" on the console and check the secret is never shown; click "Disconnect" and confirm it disappears.
9. As a user limited to one customer, check they see only consoles bound to their customer.
Expected result: Endpoints match the vendor console and matched to the right managed computers, verdicts make sense, coverage figure matches reality; the secrets never come back to the screen.
Report if: Connect fails with correct credentials (copy the exact message), wrong or missing endpoints, a computer matched to the wrong customer, a verdict that disagrees with the vendor console, a missing alert or an alert that does not clear. Tell us which product you used; the exact fields and verdict rules are unverified against real accounts. Sophos, ESET, Bitdefender and acting on an endpoint are not built.

### 8.3 Disk encryption (BitLocker) status and key escrow
Needs: A Windows test VM with the agent and BitLocker turned on (a TPM or virtual TPM, one extra drive is useful); an Owner login (keys are visible to Owner only until granted); a developer or admin to set the policy. Do not use a customer machine first.
Steps:
1. Open Automation > Policies, edit (or create) a policy applied to the test VM, open the "Device secrets" section, and set BitLocker escrow on (the setting security.bitlockerEscrow). Save.
2. Open the VM's device page > "Security" tab and click "Scan now". Check BitLocker status per volume matches "manage-bde -status" on the VM.
3. In the Device secrets card on that tab click "Escrow keys" and confirm ("Escrow BitLocker recovery keys now?").
4. Wait for "Waiting for the device to answer…" to finish; the volumes should list "Key id ending ...".
5. Click "Reveal" on a key, type a reason (needed), click confirm; the key shows for 60 seconds and then hides. Compare it with "manage-bde -protectors -get C:".
6. Open the Security page (top bar Monitoring > Security) and the "Secret access log": your reveal with your reason must be there.
7. Sign in as a non-Owner without the right to reveal secrets and check no key can be seen.
8. Check Tickets/Administration > Audit Logs show no key text anywhere.
Expected result: Status per volume is correct; the key you reveal equals the real key; reveal needs a reason, hides after 60 seconds and is logged; others cannot reveal.
Report if: The key differs or is missing, a key appears in any log, ticket or job output, escrow runs when the policy is off, a user without the right can reveal, or the VM is changed in any way (protectors added/removed). This has never run on a real device, so report every error text exactly.

### 8.4 Local admin and password management (LAPS-style)
Needs: A Windows test VM with the agent (never a customer machine for the first test), an Owner login, and access to log on to the VM with the managed account to prove the password works.
Steps:
1. Automation > Policies: edit the policy applied to the VM, open "Device secrets", switch the local admin password management on (laps.enabled) with the default account adg-admin. Save.
2. On the VM, check after a minute that a local account adg-admin exists (and that the built-in Administrator was not changed).
3. Open the device > "Security" tab and find "Local administrator password" in the Device secrets card. Click "Rotate password" and confirm.
4. Wait until it shows the account and "Last changed" and "Next rotation due".
5. Click "Reveal", type a reason, confirm. Within 60 seconds log on to the VM (for example runas or the sign-in screen) with adg-admin and this password.
6. After the reveal, note the "Rotation after a reveal due"; wait that many minutes and check the password changed (reveal the new one and log on again; the old one must fail).
7. Rotate several times and check only the last 3 generations are kept.
8. Switch the VM off during a rotation (or block its network) and check the old password stays revealable and an error such as "The last rotation could not be confirmed" is shown.
9. Check the Secret access log under Monitoring > Security.
Expected result: The managed account exists; the revealed password works for a real logon; rotation happens on schedule and after a reveal; failed rotations keep the old password; every reveal is logged.
Report if: Revealed password does not log on, account missing or the built-in Administrator touched, no rotation after a reveal, the password shows after 60 seconds, or any error text. Never run on a real device yet, so report all behaviour.

### 8.5 Security baseline checks and scoring
Needs: Console login; several Windows devices with the agent (include one deliberately weak: firewall off, Defender off, SMB1, an old OS if possible); a PDF viewer.
Steps:
1. Open a Windows device > "Security" tab and click "Scan now".
2. Read the score and grade (A to F) and the failed rules with their "why" and "how to fix" text. Check at least five rules against the PC (antivirus, firewall, UAC, BitLocker, Secure Boot, TPM, RDP, screen lock, password policy).
3. Fix one problem on the PC (for example turn the firewall on) and rescan; the score should rise.
4. Open Monitoring > Security (the fleet page): check "Devices with their security score", the Average score, Grade, Critical failures, "Checks failing on the most devices", and use "Search devices or customers" and "Sort".
5. Select several devices on the device list and use the bulk bar to start a bulk scan.
6. Business > Reports > Security group > "Security posture" and download the PDF.
7. In Automation > Policies > Security section set the scan hours (security.scanHours) to a small number and check a scan runs by itself.
8. Check a Windows version that is out of support is flagged. The end-of-support dates should be compared with Microsoft's lifecycle pages (ask the developer which table is used).
Expected result: Scores and failed rules match the real PC state; a critical failure caps the grade; fixing something raises the score after a rescan; the fleet page and report agree.
Report if: A rule says failed when the setting is correct (or the reverse), a wrong end-of-support date, a missing "how to fix" text, a Linux or Mac device being scored, or scans that never run on schedule.

### 8.6 Endpoint backup integrations
Needs: A Windows PC and a Linux machine with the agent online, ideally one with real backup software installed (for example Veeam, Acronis, Windows Backup) and one with only restore points or nothing; console login with settings access; email or alerts set up to see alerts.
Steps:
1. Open Devices > Endpoint backups.
2. If it says "Backup checks are off." click "Turn on backup checks". Under Settings check "Warn after (hours)" (48), "Failing after (hours)" (168) and "Look every (hours)".
3. Click "Check backups on computers" (or the "Check now" icon on one row) and wait.
4. Read each row's Status, Last backup, What protects it and the reason.
5. Compare with reality: a computer with a real recent backup should be Protected; one with only restore points should be a warning; one with backup software whose results cannot be read should show "Can't tell"; none should say "No successful backup seen".
6. Check Monitoring > Alerts for the matching alert (critical for failing or none, warning otherwise) and that it clears after a good backup.
7. Change the thresholds (for example Warn after 1 hour) and check the status changes on the next check.
8. Sign in as a user limited to one customer and check they see only their computers.
Expected result: Statuses follow the rules above; the alert appears and clears; limited users see only theirs; backup software on Linux (Borg, restic, Timeshift and so on) and Windows is recognised.
Report if: A computer with a working recent backup shows as not protected (or the reverse), the wrong software name, alerts that do not clear or are duplicated, the check that never finishes, or a computer that is slowed by the check. Third-party console results, macOS and restore testing are not built.

### 8.7 Microsoft 365 tenant management
Needs: A real Microsoft 365 tenant you may read (a test tenant is best, ideally with some users, licences, an admin without MFA, and conditional access or security defaults); Microsoft Entra admin rights to register an app; console login with customers.write.
Steps:
1. Open Monitoring > Microsoft 365.
2. Read "How to set it up in Microsoft Entra (once per customer)". In Entra register an app, add the seven read permissions under "API permissions > Add > Microsoft Graph > Application permissions" and "Grant admin consent", then "Certificates & secrets > New client secret" and copy its Value.
3. In ADG RMM click "Connect a tenant", choose the customer, enter "Tenant ID or domain", "Application (client) ID" and the secret Value, and connect.
4. Click "Read" (or wait for the daily read) and wait for "Reading…" to finish.
5. Check each part: people and guests; Licences (Bought, Given out, Free) with names you know; disabled accounts still holding a licence; licensed people not signed in for 90 days; "Without multi-factor sign-in"; Administrators (global admin count); whether something enforces MFA; "Microsoft Secure Score" and "Health out of 100". Compare each with the Microsoft 365 admin center.
6. Check "What could not be read" lists any part the app lacks permission for, and that no finding is made up from it (remove one permission and read again to test).
7. Enter a wrong secret on "Change the app or secret" and check the error message is clear; confirm the secret is never shown again.
8. Confirm a new critical finding reaches your webhook or Slack/Teams channel.
9. As a user limited to one customer, check they see only their tenant.
Expected result: The counts and findings match the admin center; parts without rights are marked as unread; the secret never comes back.
Report if: Wrong counts, sign-in times or MFA numbers that differ from Microsoft (these depend on the tenant's Entra licence, so note your licence level), a finding made up from an unreadable part, an error with a correct app, or a secret visible anywhere. This was never tried against a real tenant.

### 9.1 Public REST API and documentation
Needs: Console login. This item is only partly built.
Steps:
1. Open the user menu in the top bar and go to Account, find the personal access tokens, and create one.
2. Check the token works for a simple call only if a developer gives you a ready command (for example reading the device list).
Expected result: Tokens can be created and shown once. No published API documentation exists yet.
Report if: Token creation fails or the token cannot be revoked. Do not report missing API documentation, it is known and not built.

### 9.2 Outbound webhooks
Needs: Console login with settings access; a place that receives webhooks you can see (for example a free request-catcher site; use only test data); a test ticket and device.
Steps:
1. Open Administration > Integrations and find "Outbound webhooks".
2. Click "New webhook", enter a Name (for example "Ops chat"), the Address (placeholder https://example.com/hooks/adgrmm), tick the "Events to send" (ticket created, ticket updated, alert opened, alert resolved, device offline) and save. Copy the signing secret shown and click "I have saved it".
3. Click "Test" on the webhook and check your receiver gets a request with X-ADG-Event, X-ADG-Timestamp, X-ADG-Signature headers.
4. Check the signature with the instructions "How to check a delivery is genuine" (ask the developer for help if needed).
5. Create a ticket, update it, raise and resolve an alert, and shut down a test device; check each event arrives.
6. Make your receiver return an error and check the delivery log (Event, Attempts, Result) shows retries.
7. Rotate the secret and check old signatures stop matching.
Expected result: Each event arrives once with a valid signature; failures retry and are logged; test send and rotation work.
Report if: Missing or duplicate events, a signature that does not verify, no retries on failure, a secret shown a second time, or a delivery log that stays empty.

### 9.3 Slack and Teams
Needs: Console login with settings access; a Slack workspace with an incoming webhook, a Microsoft Teams channel with a Workflows webhook, and a Discord server with a webhook (use any that you have; all three is best); a test ticket and device.
Steps:
1. Administration > Integrations > "Outbound webhooks" > "New webhook".
2. Paste a Slack address (hooks.slack.com...) and check the message style is picked automatically; or choose by hand "A Slack message", "A Microsoft Teams card" or "A Discord message" in the Message setting.
3. Click "Test" and check the message reads as normal chat text and not JSON.
4. Create a ticket and edit it (change priority); check the chat message says what changed and by whom, and has a working link or an "Open" button in Teams.
5. Raise an alert, resolve it, and shut down a test device; check the wording and links. Add a domain or certificate monitor (see 9.4) to see those events.
6. Put "@channel" and "@everyone" in a ticket subject and check the chat does not ping everyone.
7. Write a very long ticket description and check the message is cut.
8. Enter a wrong Slack address path and check the delivery log shows what the chat service replied and that it was not retried forever.
Expected result: Readable messages in the right format per service, with links, no mass mentions, long text cut, and clear errors in the delivery log.
Report if: Raw JSON in chat, a mass mention going out, a broken link, a Teams card that does not render, messages that never arrive, or retries on a wrong address. Real Slack, Teams and Discord are the unproven part; two-way chat is not built.

### 9.4 Domain, DNS and certificate monitoring
Needs: Console login; a customer; a real website with a valid certificate, one you own with a soon-to-expire or wrong-name certificate if possible (badssl.com test sites work for expired, self-signed and wrong-name), a domain you own with real registration and DNS you can edit; a mailbox for alert emails; optionally a Slack/Teams webhook.
Steps:
1. Open Monitoring > Domains and certificates.
2. Click "Add a monitor". For "What to monitor" pick Certificates, enter a host (and Port 443), choose the customer, optional Name, set "Warn when fewer days are left than" and "Call it a problem below". Save.
3. Click "Check now" on the row and read Status and "What it says" (days left, trusted, right name). Repeat for expired.badssl.com, self-signed.badssl.com and wrong.host.badssl.com.
4. Add a monitor for Domains with a real domain; check expiry date and status; try a country-code domain (such as .co.uk or .de) and a sub-domain and note what happens.
5. Add a DNS records monitor: add records to watch (A, MX, TXT and so on); in "Should be (optional)" type the expected values or leave blank to learn them.
6. Change a record at your DNS host and wait up to 15 minutes (or click "Check now"). A warning with what went and what came should appear; click "Accept the new records".
7. Check the email to the alert recipients arrives and that webhooks/Slack/Teams get monitor.failed and later monitor.recovered once.
8. Add a host that is unreachable and check it only turns to an error after three checks in a row.
9. Try to add a private address (such as 192.168.1.1 or localhost) and check it is refused.
Expected result: Statuses match reality; state changes announced once by email and webhook; private addresses refused; one click accepts new DNS records.
Report if: Wrong days left, valid certificate called bad (or the reverse), a domain reported with no expiry when the registry does have one, no email, repeated emails for the same state, a private address accepted, or errors on the domain types listed. The real rdap.org lookup and real email are the unproven parts.

### 9.5 Mobile app or installable web app for technicians
Needs: A phone (iPhone or Android) with a browser. This item is only partly built: the dashboard works on phones, with no alerts or app.
Steps:
1. On the phone open https://console.example.com and sign in.
2. Open the Dashboard, then the top-bar menus Devices, Monitoring, Service desk, and open a ticket and a device.
3. Try to reply to a ticket and to read an alert.
Expected result: Pages fit the screen, menus open, tickets and devices are readable and usable.
Report if: Text cut off, buttons that cannot be tapped, sideways scrolling or pages that do not load. Do not report missing push alerts or a store app; they are not built.

### 9.6 Migration tools from other RMMs and PSAs
Needs: A Freshdesk account with test tickets, contacts and companies, and its API key and domain; Administration access. Only Freshdesk is built.
Steps:
1. Open Administration > Import from Freshdesk.
2. Enter the Freshdesk details and run the preview. Read the counts of tickets, contacts and companies.
3. Compare the counts with Freshdesk itself.
4. Run the import. Open Service desk > Tickets and check three imported tickets have every reply and the private notes (private notes must stay private) and the right company and contact.
5. Run the import a second time and check nothing is duplicated.
Expected result: The preview counts match Freshdesk; the import brings tickets with all replies and notes, contacts and companies; no duplicates on a re-run.
Report if: Missing replies or notes, a private note shown to the customer, wrong dates or requesters, duplicates, or errors. Other RMMs and PSAs are not built.

### 10.1 Sign Remote Console, shell and RDP session starts
Needs: A Windows PC with a recent agent (1.3.5 or newer) enrolled; console login with remote access rights; a Linux VM too if possible.
Steps:
1. Open the device and click the "Remote" tab.
2. Start the remote console (and the remote shell and remote desktop if listed) and use it for a minute.
3. Open a second device and do the same.
4. Ask the developer to try an unsigned start against the agent (this part needs a developer).
Expected result: Sessions start normally every time. An unsigned start is refused by the agent.
Report if: A session that fails to start with a signature or "refused" error, only some devices failing, sessions that start slowly after an agent update, or (developer test) an unsigned start that is accepted.

### 10.2 Encrypt stored SMTP, IMAP, storage and DKIM credentials
Needs: Console login as an administrator; a working SMTP mailbox; a developer with database access to confirm the stored values (testers cannot see this).
Steps:
1. Administration > SMTP: check the saved password still works by sending a test email. Do the same on Support Mailbox (IMAP), Storage (S3) and the DKIM section.
2. Restart or have the developer restart the server; repeat the tests.
3. Developer: check the database values are encrypted and not readable text.
Expected result: All mail, mailbox, storage and DKIM settings keep working after saving and after a restart; stored values are unreadable.
Report if: Any test email, mailbox read or storage upload that worked before now fails, a password field that blanks itself or a saved password that is shown in clear text in the page.

### 10.4 Fix npm audit findings (36 in the backend)
Needs: A developer. This is a code dependency task; a tester cannot check it.
Steps:
1. Use the product normally (login, tickets, email sending, reports) and watch for new errors after the update.
Expected result: Everything behaves as before; the remaining findings are known and need major upgrades (nodemailer first).
Report if: Any feature that worked before breaks, especially sending email.

### 10.6 Encrypt backup archives
Needs: Administrator login; a test server (never the live one for the restore step); a developer for the restore part.
Steps:
1. Open Administration > Backups. Ask the developer to switch backup encryption on (it is off by default).
2. Create a backup, then download it with the download button on its row. Try to open it with an archive tool; it must not be readable.
3. Developer: restore the encrypted backup into a spare server and check all data (tickets, devices, users) is present.
4. Developer: change one byte of an archive and check the restore refuses it.
Expected result: Archives are unreadable without the key; tampering is detected; a full restore gives back all data.
Report if: A backup that cannot be restored, a downloaded archive that is readable, backups that fail only when encryption is on. The full database restore is the unproven part and needs a developer.

### 10.10 Staged rollout: test group first, then everyone
Needs: Owner login (or the agents.release.manage right); at least two enrolled devices (one will be the test device); a new agent build placed in the candidate slot by the developer.
Steps:
1. Open a device page and in the "Update ring" box choose "Pilot" and click "Save ring". Leave a second device on Everyone.
2. Alternatively select devices in the device list and use "Update ring" in the bulk bar, or set the customer default under the customer.
3. Ask the developer to put a new agent build in the candidate slot.
4. Open Administration > Agents and read the "Releases" box: Candidate, Offered to Pilot devices only, and the pilot health numbers (Pilot devices, online now, seen online after updating, not updated yet, quiet for 30+ min since updating, last update job failed).
5. Check the Pilot device updates and the Everyone device does not.
6. When the pilot health gate is good, click "Promote candidate to everyone"; check the other device then updates.
7. With a second candidate, click "Withdraw candidate" and check it is no longer offered.
8. Check a device that has already updated does not downgrade.
Expected result: Only pilot devices get the candidate; health numbers are correct; promote moves it to everyone; withdraw removes it; no downgrades.
Report if: A non-pilot device updates before promotion, a gate that shows wrong numbers, a promote button that works when the gate is red without asking for a reason, or a user without the right being able to promote. No real candidate has been through this yet.

### 10.12 Automated test suite
Needs: A developer. A tester cannot check this.
Steps:
1. None for testers.
Expected result: Developer runs the 119 checks in CI on demand and they pass.
Report if: Not applicable for testers; developers report any failing check.

### 10.13 Monitoring of ADG RMM's own servers
Needs: Administrator login; a developer to help cause failures on a test server (testers should not stop the live server); an alert target (email, Slack or webhook as set for backups).
Steps:
1. Open Administration > System and find the "Server health" card.
2. Read the checks: database, server disk space, memory, stuck jobs, newest good backup, restore test, web console, agent address, computers reaching the server. Each should show "All fine", "Needs a look" or "Needs attention now".
3. Click "Restore tests" to see the history list and the restore test button to run one now.
4. Ask the developer to cause a harmless fault on a test server (for example stop backups or fill a test disk). Wait a few minutes and check the status changes and one message arrives by email, Slack or webhook.
5. Fix the fault and check a single recovery message arrives.
6. Leave it for several days and look at the history for false alarms.
Expected result: Statuses are true; a state change is sent once, recovery once; history is kept.
Report if: A status that is wrong, repeated messages for the same problem, no message, or false alarms over several days. Behaviour over days is not yet proven.

### 10.15 Tested restore of a production backup
Needs: Administrator login. Run only on the live server through the button, never by restoring anything yourself.
Steps:
1. Open Administration > System, "Server health" card.
2. Look at "Restore tests": the last test date, result and time taken.
3. Click the restore test button (the test run now button next to the title, you will see "Restore test started").
4. Wait about a minute, refresh, and read the new entry.
5. Check production still works normally (sign in, open a ticket).
Expected result: A new restore test appears and completes in under a minute or two with a success result; production is not affected. A failure shows critical with a reason and is retried after 24 hours.
Report if: The test fails (note the reason shown), takes much longer than a minute, or the console slows or errors while it runs. The 30 day and 35 day warnings only show with time, so you cannot test them directly.

### 10.17 One-command self-hosted install
Needs: A fresh Ubuntu 22.04, 24.04 or Debian 12 machine or VM with a sudo user and internet; optionally a real domain name pointing to it (for Let's Encrypt) and a real mailbox.
Steps:
1. Ask the developer for the install command or the release (GitHub Releases, v0.1.4) and copy install/install.sh to the machine.
2. Run it and choose Docker or native, then built-in HTTPS or your own proxy. Answer the first-run questions.
3. Open the web address it prints and finish first-run setup (create the owner account).
4. Run the "status" command and check everything is healthy.
5. Run "reconfigure" and change one setting.
6. Run the upgrade command (it must take a backup first) and then try the rollback.
7. If you have a domain, install with built-in HTTPS and check the browser shows a valid Let's Encrypt certificate.
8. Set up SMTP and send a test email.
9. Run uninstall and check what is left behind.
Expected result: Each command finishes without errors; the console opens; upgrade takes a backup and rollback works; uninstall removes it.
Report if: Any command stops with an error (copy the last 30 lines), a certificate that is not issued, an upgrade that loses data or cannot roll back, or a console that does not open after reboot. A real Let's Encrypt certificate and real email are the untested parts.

### 10.18 Admin and user documentation
Needs: A reader; this is only partly built.
Steps:
1. Read the installer README and follow it on a spare machine (see 10.17).
2. Note any step that is unclear, missing or wrong.
Expected result: The README is understandable and complete for an install. Admin and user guides do not exist yet.
Report if: A README step that fails or is unclear. Do not report the missing admin and user guides; they are known.
