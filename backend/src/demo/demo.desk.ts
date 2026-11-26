// backend/src/demo/demo.desk.ts
//
// Service desk content for the demo: forty tickets with the conversation that went with them, plus a few canned replies and
// ticket templates. Everything is fictional. The conversation is written as steps:
//   c = the customer wrote (inbound reply), r = a technician replied to the customer, n = internal note, h = handoff note.
// Each step carries the hours since the previous one and, for technicians, the minutes of work logged with it.

export type Step = ["c" | "r" | "n" | "h", number, string, number?];
export type TicketSeed = {
    cust: number; contact: number; host?: string; subject: string; desc: string;
    pri: "low" | "normal" | "high" | "urgent"; status: "open" | "pending" | "in_progress" | "resolved" | "closed";
    /** Hours ago it was opened. */
    age: number;
    /** A technician (0 to 3), "me" for the signed-in user, or null for unassigned. */
    who: number | "me" | null;
    via: "email" | "portal" | "ui" | "alert" | "tray";
    queue: 0 | 1 | 2; tags?: string[]; steps: Step[];
    /** Survey answer for a solved ticket: [score 1 to 5, comment]. */
    survey?: [number, string];
    /** Knowledge base articles (by position) used to solve it. */
    kb?: number[];
};

export const TICKETS: TicketSeed[] = [
    {
        cust: 0, contact: 0, host: "HAR-XRAY-03", subject: "X-ray workstation will not open the imaging software", pri: "urgent", status: "in_progress", age: 30, who: 0, via: "email", queue: 0, tags: ["imaging", "urgent"],
        desc: "Hi, the PC in the X-ray room shows an error as soon as we open the imaging program. We have patients booked from 1 pm and cannot take radiographs until this works. Please call me as soon as you see this.",
        steps: [
            ["r", 0.3, "Hi Maria, we are on it. I am connecting to the X-ray PC now and will update you in a few minutes.", 10],
            ["n", 0.5, "Sensor driver service was stopped and the vendor's licence file is dated yesterday. Looks like last night's Windows update replaced the USB driver. Not touching the vendor software itself.", 25],
            ["c", 1.2, "Thank you! Dr. Patel says the first patient is at 1."],
            ["r", 0.6, "The imaging software opens again and a test exposure came through. I reinstalled the sensor driver; we will keep this machine out of automatic updates until the vendor confirms the next version. Please try it with a real patient and tell me if anything looks off.", 35],
            ["n", 20, "Waiting for the vendor to confirm driver version 4.2 before we allow updates again. Checked the PC is still online and the sensor is detected."],
        ],
    },
    {
        cust: 0, contact: 0, host: "HAR-CHAIR-02", subject: "Disk free C: on HAR-CHAIR-02", pri: "normal", status: "open", age: 52, who: null, via: "alert", queue: 2, tags: ["monitoring"],
        desc: "Created automatically from an alert: Disk free C: is at 9% (23 GB free of 256 GB).",
        steps: [["n", 0.1, "Opened by monitoring. The disk has lost about 17 points of free space in 60 days, mostly the Windows Update cache and an old photo cache from the imaging viewer."]],
    },
    {
        cust: 0, contact: 2, host: "HAR-FRONT-01", subject: "Reception printer prints blank pages", pri: "normal", status: "resolved", age: 216, who: 1, via: "portal", queue: 0, tags: ["printing"],
        desc: "The printer at the front desk prints a blank sheet after every job. We tried turning it off and on.",
        steps: [
            ["r", 1.5, "Hi Tom, thanks for the details. I can see the printer queue on your PC has several stuck jobs. I will clear it and reset the spooler.", 15],
            ["c", 0.8, "OK, go ahead."],
            ["r", 0.4, "Done. I cleared the stuck jobs, restarted the print spooler and printed a test page: it is fine now. If it prints blank pages again, the toner cartridge is the next thing to check.", 20],
        ],
        survey: [5, "Quick fix, thanks!"], kb: [2],
    },
    {
        cust: 0, contact: 0, subject: "New hygienist: email address and shared calendar", pri: "low", status: "closed", age: 384, who: 2, via: "email", queue: 0, tags: ["onboarding"],
        desc: "We have a new hygienist starting on the 14th. Could you create her email account (jessica.m) and add her to the shared appointments calendar? She will use the second chair PC.",
        steps: [
            ["r", 3, "Hi Maria, no problem. I have created the mailbox and added Jessica to the appointments calendar with edit rights. Her temporary password will be sent to you separately by text message.", 40],
            ["c", 20, "Got it, she is logged in. Thanks."],
            ["r", 1, "Great. I am closing this ticket; reply if anything is missing.", 5],
        ],
        survey: [4, "Everything worked on day one."], kb: [7],
    },
    {
        cust: 0, contact: 0, host: "HAR-SRV-01", subject: "Server has been waiting for a restart for weeks", pri: "high", status: "pending", age: 144, who: 1, via: "ui", queue: 0, tags: ["patching", "maintenance"],
        desc: "Monitoring shows the clinic server has had a restart pending for more than 100 days. The server also has several security updates waiting.",
        steps: [
            ["r", 2, "Hi Maria, the clinic server needs a restart to finish installing security updates. It takes about 15 minutes and the practice management software will be unavailable meanwhile. When would suit you? Sunday evening is usually quietest.", 10],
            ["n", 24, "No answer yet. Chased by phone, left a message with the front desk."],
            ["r", 48, "Following up on the server restart: could you tell us which evening works? Until it is restarted the server stays exposed to the updates already published.", 5],
        ],
    },
    {
        cust: 1, contact: 0, host: "SUM-PARTNER-01", subject: "Outlook keeps asking for my password", pri: "high", status: "open", age: 5, who: "me", via: "email", queue: 0, tags: ["email"],
        desc: "Since this morning Outlook on my laptop asks for my password every few minutes. I enter it and it comes back. I have a client call at 3 and need my calendar. Jonathan",
        steps: [
            ["r", 0.4, "Good morning Jonathan, thanks for flagging it. This is usually a stale sign-in token: I will clear it remotely so you do not have to do anything. May I connect now?", 10],
            ["c", 0.3, "Yes please, I am at my desk."],
            ["n", 0.5, "Cleared Credential Manager entries for Office and re-signed in. Mailbox is syncing again. Will check back before 3."],
        ],
        kb: [0],
    },
    {
        cust: 1, contact: 2, host: "SUM-PARALEGAL-02", subject: "Shared drive S: is missing after the reboot", pri: "normal", status: "resolved", age: 96, who: 0, via: "email", queue: 0, tags: ["file-server"],
        desc: "After Windows restarted overnight my S: drive does not appear. I cannot open the matter folders.",
        steps: [
            ["r", 1, "Hi Dev, the mapped drive did not reconnect because the PC started before the network was up. I am reconnecting it and setting it to reconnect at sign-in.", 20],
            ["c", 0.5, "I see it again now, thank you."],
            ["r", 0.2, "Good. I also turned on the Windows setting that waits for the network at sign-in so it should not happen again after a restart.", 10],
        ],
        survey: [4, "Fixed quickly."],
    },
    {
        cust: 1, contact: 1, host: "SUM-FILE-01", subject: "File server: D: drive is 92% full", pri: "high", status: "in_progress", age: 72, who: 2, via: "alert", queue: 2, tags: ["storage", "file-server"],
        desc: "Alert: Disk free D: on SUM-FILE-01 is 8% (320 GB free of 4 TB).",
        steps: [
            ["n", 0.3, "Largest folders: scanned documents (2.1 TB), email archives (700 GB), old matter folders (480 GB). Archiving closed matters older than seven years would free about 600 GB."],
            ["r", 3, "Hi Grace, the file server's data drive is almost full. Two options: archive closed matters older than seven years (frees about 600 GB, no cost), or add storage. I would like your approval to start with the archive. Nothing is deleted, files are moved to an archive share.", 25],
            ["c", 18, "Please go ahead with the archive but check with Jonathan about anything from the last ten years."],
            ["n", 2, "Archive job scheduled for Saturday 22:00. Quote for 4 TB extra drives to follow separately.", 15],
        ],
    },
    {
        cust: 1, contact: 1, subject: "New associate starts Monday: laptop and accounts", pri: "normal", status: "open", age: 48, who: 3, via: "email", queue: 1, tags: ["onboarding", "project"],
        desc: "We have a new associate attorney joining on Monday. We will need a laptop with the standard image, email, document management and a phone extension. Can you have it ready by Friday?",
        steps: [
            ["r", 2, "Hi Grace, absolutely. I have a laptop in stock that fits the standard image. I will build it tomorrow and send you the checklist to confirm software and access. Do you have the associate's preferred username?", 20],
            ["c", 6, "It is r.dalton. And she will need access to the litigation share."],
            ["n", 1, "Account created in the directory. Litigation share requires partner approval: asked Jonathan Summit by email.", 10],
        ],
        kb: [7],
    },
    {
        cust: 1, contact: 1, host: "SUM-REMOTE-04", subject: "Remote associate laptop has not been online for weeks", pri: "normal", status: "open", age: 336, who: 0, via: "ui", queue: 0, tags: ["remote-worker"],
        desc: "Monitoring shows the Surface laptop used by our remote associate has not reported in since the middle of the month. Please check whether it is switched off or has a problem.",
        steps: [
            ["r", 2, "Hi Grace, our monitoring has not seen the remote associate's laptop for a while. Could you ask her to open it, connect to Wi-Fi and leave it on for ten minutes? If it still does not appear we will arrange a replacement agent install.", 5],
            ["n", 70, "No contact. Tried the associate's mobile as listed: voicemail."],
            ["c", 30, "She is travelling until next week, I will ask her when she is back."],
            ["n", 160, "Still offline. Following up again Monday."],
        ],
    },
    {
        cust: 1, contact: 2, host: "SUM-INTAKE-03", subject: "Intake PC is very slow in the morning", pri: "low", status: "closed", age: 600, who: 2, via: "portal", queue: 0, tags: ["performance"],
        desc: "The front intake computer takes about ten minutes to become usable every morning.",
        steps: [
            ["r", 5, "Hi Dev, I looked at start-up: too many programs launch at sign-in and the PC only has 4 GB of memory. I have disabled seven start-up items. A memory upgrade would help more: I will send you a quote.", 40],
            ["c", 24, "Better already, thanks."],
            ["r", 2, "Glad to hear it. Closing for now, the memory upgrade quote is on its way.", 5],
        ],
        survey: [3, "Better but still slow at times."],
    },
    {
        cust: 2, contact: 0, host: "BRW-SRV-01", subject: "QuickBooks backup failing since Tuesday", pri: "urgent", status: "in_progress", age: 31, who: "me", via: "alert", queue: 2, tags: ["backup", "quickbooks"],
        desc: "Alert: Backup failed on BRW-SRV-01. The last nightly backup of the company files did not complete.",
        steps: [
            ["r", 0.6, "Hi Priti, our monitoring caught that the nightly backup of the QuickBooks files has failed. You do not need to do anything yet, we are investigating and your data is not affected.", 10],
            ["n", 1.2, "Backup volume is out of space: the old restore points were never pruned. Freed 180 GB and started a fresh run. Watching.", 30],
            ["n", 4, "Backup ran, 41 GB, verify OK. Retention policy corrected to 14 days. Leaving open until tomorrow's scheduled run succeeds.", 20],
            ["c", 5, "Thanks for catching that. Are we safe for month-end?"],
        ],
        kb: [11],
    },
    {
        cust: 2, contact: 2, host: "BRW-ACCT-02", subject: "Computer is almost out of space and very slow", pri: "high", status: "open", age: 96, who: 1, via: "email", queue: 0, tags: ["performance", "storage"],
        desc: "My computer is crawling and it says the disk is nearly full. I have tax returns to file this week. Please help. Daniel",
        steps: [
            ["r", 4, "Hi Daniel, thanks for letting us know. I can clean up temporary files remotely, but the disk is small for the amount of client data on it. I will start with the cleanup tonight so I do not interrupt your work.", 20],
            ["n", 14, "Cleanup freed 14 GB but the drive is back to 9% free. Machine is a 256 GB OptiPlex from 2018. Recommend replacement or a larger SSD."],
            ["c", 8, "Is there anything else you can do before the replacement? It is still slow."],
        ],
        kb: [11],
    },
    {
        cust: 2, contact: 3, host: "BRW-ACCT-03", subject: "Request: second monitor for Chloe", pri: "low", status: "pending", age: 192, who: 2, via: "portal", queue: 0, tags: ["hardware"],
        desc: "Could we get a second monitor for my desk? I work with two spreadsheets side by side all day.",
        steps: [
            ["r", 6, "Hi Chloe, yes. A 24 inch monitor and cable come to $189.00 plus delivery. I need approval from Priti or Elise before I order. Could you ask them to reply here?", 10],
            ["n", 50, "Priti is on leave until next Tuesday. Waiting for approval."],
        ],
    },
    {
        cust: 2, contact: 0, subject: "Tax season: extra remote access seats", pri: "normal", status: "open", age: 240, who: 3, via: "email", queue: 1, tags: ["project", "remote-access"],
        desc: "We will have two seasonal staff who need to work from home from January to April. What are our options for secure remote access and what does it cost?",
        steps: [
            ["r", 8, "Hi Priti, we can give them a protected remote desktop to their office PC so no client data sits on home computers. Each seat is $18 a month. I will send a short proposal.", 25],
            ["n", 30, "Proposal drafted, waiting for partner sign-off. Quote QUO-1004."],
        ],
    },
    {
        cust: 2, contact: 4, host: "BRW-ACCT-04", subject: "Branch laptop has not worked since last week", pri: "normal", status: "open", age: 192, who: 0, via: "email", queue: 0, tags: ["remote-worker"],
        desc: "My laptop will not turn on since I came back from the road trip. The charging light blinks twice. Luke",
        steps: [
            ["r", 5, "Hi Luke, a blinking charge light usually means the battery or charger. Please try holding the power button for 30 seconds, then plug in the charger and try again. If it still does not start, we will send a replacement battery.", 10],
            ["c", 40, "Tried that, nothing. The charger is warm though."],
            ["n", 4, "Probably the battery. Ordered one under warranty, ETA four days.", 15],
        ],
    },
    {
        cust: 2, contact: 4, subject: "Cannot scan to email from the office copier", pri: "normal", status: "resolved", age: 144, who: 2, via: "email", queue: 0, tags: ["printing"],
        desc: "Scan to email has stopped working on the second floor copier. It says 'could not connect to server'.",
        steps: [
            ["r", 2, "Hi, the copier was using an old mail setting that the email provider retired. I will update the copier with the new settings today.", 15],
            ["r", 3, "Updated and tested: I sent a scan to Priti's address and it arrived. Please try one yourself.", 25],
            ["c", 1, "It works, thank you!"],
        ],
        survey: [5, "Perfect."], kb: [3],
    },
    {
        cust: 2, contact: 2, subject: "Suspicious email: asked to update payment details", pri: "high", status: "resolved", age: 288, who: 0, via: "email", queue: 0, tags: ["security", "phishing"],
        desc: "I received an email that looks like it is from our bank asking me to confirm account details through a link. I have not clicked it. What should I do?",
        steps: [
            ["r", 0.4, "Thank you for not clicking, Daniel, that was exactly right. I am checking the message headers now and will remove the email from every mailbox at the firm.", 30],
            ["n", 0.8, "Confirmed phishing: sender domain was registered three days ago. Purged from 17 mailboxes, blocked the domain, no clicks in the web filter logs.", 25],
            ["r", 0.4, "All clear: it was a phishing attempt, the message has been removed from every mailbox and the sender is blocked. If anyone else mentions it, forward it to us rather than opening it.", 5],
        ],
        survey: [5, "Fast and clear."], kb: [9],
    },
    {
        cust: 3, contact: 2, host: "LRK-POS-03", subject: "POS terminal 3 in Store 2 will not turn on", pri: "urgent", status: "open", age: 150, who: 0, via: "email", queue: 0, tags: ["pos", "hardware"],
        desc: "The register at till 3 is dead. No lights at all. We are running two tills and the queue at the weekend is long. Please hurry. Hector",
        steps: [
            ["r", 0.7, "Hi Hector, I can see the terminal has not reported in since it went down. Please check the power brick light and that the power strip is on. If there is still no light it is probably the power supply.", 10],
            ["c", 1.5, "Power strip is fine, brick light is off."],
            ["n", 0.5, "Power brick dead. Replacement shipping from our supplier, ETA Tuesday. Customer using two tills in the meantime.", 20],
            ["n", 90, "Brick delayed by courier. Re-chased the supplier."],
        ],
    },
    {
        cust: 3, contact: 0, host: "LRK-SRV-01", subject: "Warehouse server: no antivirus protection", pri: "urgent", status: "in_progress", age: 70, who: 1, via: "alert", queue: 2, tags: ["security", "server"],
        desc: "Alert: no antivirus reports in on LRK-SRV-01. Defender found a threat that has not been cleaned.",
        steps: [
            ["r", 1, "Hi Dana, our security check found the warehouse server has no active antivirus, and a suspicious file in the invoices share. We need to isolate and scan it today. Expect the shared folder to be unavailable for about an hour.", 20],
            ["c", 3, "Fine, as long as warehouse can print labels after lunch."],
            ["n", 2, "Installed endpoint protection, full scan running. Found 1 infected file in D:\\Share\\Invoices. Quarantined. Server is also 8 years old: recommend replacement plan.", 90],
        ],
        kb: [10],
    },
    {
        cust: 3, contact: 0, host: "LRK-POS-01", subject: "Receipt printer jams at Store 1", pri: "low", status: "resolved", age: 360, who: 2, via: "tray", queue: 0, tags: ["printing", "pos"],
        desc: "Receipt printer keeps jamming after a few receipts.",
        steps: [
            ["r", 2, "Hi Dana, the paper roll was a different width than the printer expects. Please use 80 mm rolls. I have also cleaned up the printer settings from here.", 15],
            ["c", 20, "That fixed it, thanks."],
        ],
        survey: [4, "Simple fix."],
    },
    {
        cust: 3, contact: 1, host: "LRK-WEB-01", subject: "Website slow during the weekend sale", pri: "high", status: "resolved", age: 500, who: 2, via: "email", queue: 0, tags: ["website", "linux"],
        desc: "Our website is crawling and some customers cannot check out. The sale ends tonight!",
        steps: [
            ["r", 0.3, "Hi Marcus, looking at it right now.", 5],
            ["n", 0.5, "The web server is out of worker processes because a plugin is making slow database queries. Raised the worker limit and restarted PHP. Response time dropped from 9 s to 0.6 s.", 40],
            ["r", 0.3, "The site is fast again: checkout works. We will review the plugin and the server capacity on Monday so the next sale is not at risk.", 15],
            ["c", 2, "Thank you, you saved the weekend."],
        ],
        survey: [5, "Immediate response when it mattered."],
    },
    {
        cust: 3, contact: 2, subject: "Guest Wi-Fi for Store 2", pri: "low", status: "open", age: 480, who: 3, via: "portal", queue: 1, tags: ["project", "network"],
        desc: "Customers in Store 2 keep asking for Wi-Fi. Can we add a guest network that is separate from the till network?",
        steps: [
            ["r", 20, "Hi Hector, yes: we would add a separate guest network on the existing access point so it cannot reach the tills. Setup takes about an hour onsite. I will send a quote for the visit.", 15],
            ["n", 100, "Quote sent, waiting."],
        ],
    },
    {
        cust: 3, contact: 0, host: "LRK-BACKOFFICE-01", subject: "Back office PC asks to restart every day", pri: "low", status: "closed", age: 720, who: 1, via: "ui", queue: 0, tags: ["patching"],
        desc: "The back office computer says 'restart to finish updates' every day, and we postpone it.",
        steps: [
            ["r", 6, "Hi Dana, the updates need one restart. I have scheduled it for tonight at 11 pm; please leave the PC on.", 10],
            ["n", 15, "Restarted OK, updates installed."],
        ],
        kb: [8],
    },
    {
        cust: 4, contact: 0, host: "IRB-ERP-01", subject: "ERP server: SQL Agent keeps stopping", pri: "urgent", status: "in_progress", age: 22, who: "me", via: "alert", queue: 2, tags: ["erp", "server", "sql"],
        desc: "Alert: Service SQLSERVERAGENT is not running on IRB-ERP-01. Nightly jobs have not run.",
        steps: [
            ["r", 0.4, "Hi Dwayne, the ERP database agent stopped and the overnight jobs did not run. We are working on it now and will keep the ERP available.", 20],
            ["n", 1.5, "Service stops 6 minutes after start with error 17058: cannot write to the log directory (volume nearly full) and the account's password was changed by policy. Cleared logs, reset the service account.", 60],
            ["n", 2, "Started but stopped again after the failed Windows update tried to restart it. Windows Update is failing with 0x80073712, which is why this server is 140 days behind on restarts.", 45],
            ["c", 3, "Our shipping system still cannot see the nightly pick lists."],
        ],
    },
    {
        cust: 4, contact: 2, host: "IRB-CAD-02", subject: "CAD workstation 02 is out of disk space", pri: "high", status: "open", age: 40, who: 2, via: "alert", queue: 0, tags: ["cad", "storage"],
        desc: "Alert: Disk free C: on IRB-CAD-02 is 4%.",
        steps: [
            ["r", 3, "Hi Rachel, your drawing cache and the temp folder from the renderer are taking 400 GB. Can I move the project cache to the shared drive tonight? Open files will not be affected.", 15],
            ["c", 14, "Yes please but not the active job for Henderson."],
        ],
    },
    {
        cust: 4, contact: 4, host: "IRB-PLANT-PC-01", subject: "Plant PC 1 flagged for malware", pri: "high", status: "in_progress", age: 168, who: 1, via: "alert", queue: 2, tags: ["security", "plant"],
        desc: "Alert: Defender quarantined a trojan on IRB-PLANT-PC-01 and could not remove a second threat.",
        steps: [
            ["r", 2, "Hi Bill, our security check found two infected files on the Plant PC 1 from a USB drive. Please do not plug in any more USB drives. We will clean it remotely tonight.", 20],
            ["c", 5, "OK. Operators were using a USB stick to move drawings."],
            ["n", 15, "Ran offline scan, removed both. Antivirus definitions were 9 days old because this PC is not on the network overnight. Need a safe way to transfer drawings: suggested a shared folder.", 75],
            ["h", 48, "Left for next shift: set up the drawings share for the plant (Dwayne approved), disable USB storage once the share works, re-scan Friday."],
        ],
        kb: [10],
    },
    {
        cust: 4, contact: 0, host: "IRB-PLANT-PC-02", subject: "Plant PC 2 is not reporting in", pri: "normal", status: "open", age: 96, who: null, via: "alert", queue: 2, tags: ["monitoring", "plant"],
        desc: "Alert: IRB-PLANT-PC-02 is offline. Last seen 4 days ago.",
        steps: [["n", 0.2, "Opened by monitoring. Machine runs a CNC controller: needs a scheduled visit rather than remote work."]],
    },
    {
        cust: 4, contact: 0, subject: "New engineer: VPN and file share access", pri: "normal", status: "resolved", age: 264, who: 0, via: "email", queue: 0, tags: ["onboarding"],
        desc: "We have a new design engineer starting Monday. Please give him a VPN login and access to the engineering and CAD shares.",
        steps: [
            ["r", 2, "Hi Dwayne, done: his VPN account and share access are ready. I have emailed the VPN setup guide to him and sent the sign-in details by text to you.", 35],
            ["c", 30, "He is connected, thanks."],
        ],
        survey: [5, "Smooth as always."], kb: [4, 7],
    },
    {
        cust: 4, contact: 1, host: "IRB-LNX-DB01", subject: "PostgreSQL server memory usage is high", pri: "normal", status: "pending", age: 120, who: 3, via: "alert", queue: 2, tags: ["linux", "database"],
        desc: "Alert: Memory usage on IRB-LNX-DB01 is 93%.",
        steps: [
            ["n", 0.3, "Checked: most of the memory is database cache, which is expected, but swap is also in use. Two reporting queries run until 03:00."],
            ["r", 5, "Hi Tomasz, the memory use looks normal for the database cache, but the nightly report queries are swapping. Could your team look at the 2 am report schedule? We can add memory if you want to keep it as is.", 25],
        ],
    },
    {
        cust: 4, contact: 2, subject: "Plan: replace the Windows 10 PCs before support ends", pri: "normal", status: "open", age: 312, who: 3, via: "email", queue: 1, tags: ["project", "windows10"],
        desc: "Windows 10 is going out of support. Four PCs in the plant and two offices are still on it. We need a plan and a budget. The plant PCs run machine software that may not work on Windows 11.",
        steps: [
            ["r", 10, "Hi Rachel, we will audit which PCs can move to Windows 11 and which machines run software that needs a different approach, such as isolating them on their own network. I will have the audit by the end of next week.", 45],
            ["n", 80, "Audit: 3 PCs not Windows 11 capable (TPM missing). Machine software vendor says Windows 11 is supported from version 8: asked for the upgrade price."],
        ],
    },
    {
        cust: 4, contact: 2, host: "IRB-OFFICE-01", subject: "Label printer not working after Windows update", pri: "low", status: "resolved", age: 120, who: 1, via: "portal", queue: 0, tags: ["printing"],
        desc: "The shipping label printer stopped working after the PC updated. It shows in Windows but nothing prints.",
        steps: [
            ["r", 1, "Hi Rachel, Windows replaced the label printer driver with a generic one. I have reinstalled the manufacturer's driver and printed a test label.", 25],
            ["c", 1, "Working. Thanks!"],
        ],
        survey: [5, "Thanks!"],
    },
    {
        cust: 5, contact: 0, host: "MGA-LAB-01", subject: "Computer lab PCs are slow to log in", pri: "normal", status: "open", age: 70, who: 2, via: "portal", queue: 0, tags: ["lab", "performance"],
        desc: "All the PCs in the science lab take 5 minutes to sign in on Monday mornings. Teachers lose the first 10 minutes of the lesson.",
        steps: [
            ["r", 3, "Hi Sandra, thanks. It is likely the roaming profiles and the updates that run when the lab PCs start up. I will check one PC tomorrow before first period.", 20],
            ["n", 18, "Measured 4m10s sign-in on LAB-01: profile sync is 2 GB because students save to the desktop. Plan: redirect folders and clear old profiles."],
        ],
    },
    {
        cust: 5, contact: 3, host: "MGA-LAB-03", subject: "Lab PC 3 will not power on", pri: "normal", status: "open", age: 288, who: 0, via: "email", queue: 0, tags: ["lab", "hardware"],
        desc: "Lab computer number 3 does not start. The screen stays black. Students are sharing the other two.",
        steps: [
            ["r", 8, "Hi Paul, thanks. Could you check the power cable at the back and try the other monitor cable? If it is still black, I will come on Thursday to test it.", 10],
            ["c", 30, "Cable is fine. It makes a clicking noise."],
            ["n", 24, "Clicking = failing drive. Visit scheduled Thursday with a spare SSD.", 15],
            ["n", 70, "Visit postponed: school closed for a staff day. Rebooked for next Tuesday."],
        ],
    },
    {
        cust: 5, contact: 2, host: "MGA-TEACH-01", subject: "Cannot connect laptop to the classroom projector", pri: "normal", status: "resolved", age: 168, who: 1, via: "portal", queue: 0, tags: ["classroom"],
        desc: "My laptop no longer shows the picture on the projector in room 12.",
        steps: [
            ["r", 2, "Hi Miguel, the laptop's display settings switched to 'PC screen only' after an update. Press Windows key + P and choose Duplicate: that should bring it back. I can also do it for you remotely.", 10],
            ["c", 3, "Windows + P worked. Thanks!"],
        ],
        survey: [4, "Quick answer."], kb: [],
    },
    {
        cust: 5, contact: 0, subject: "Create 40 new student accounts for September", pri: "normal", status: "closed", age: 672, who: 3, via: "email", queue: 1, tags: ["onboarding", "project"],
        desc: "We have 40 new students enrolling in September. Please create their sign-ins and add them to the right class groups. The list is attached.",
        steps: [
            ["r", 5, "Hi Sandra, received the list. I will create the accounts and class groups by Friday and send you the sign-in sheet in a password-protected file.", 90],
            ["c", 52, "Got the sheet, everything looks right."],
            ["r", 2, "Wonderful. I am closing this ticket; let us know about any late enrolments.", 10],
        ],
        survey: [5, "Ready a week early."], kb: [6],
    },
    {
        cust: 5, contact: 3, host: "MGA-LNX-PROXY01", subject: "Web filter blocks an educational site", pri: "normal", status: "resolved", age: 216, who: 0, via: "email", queue: 0, tags: ["web-filter", "linux"],
        desc: "A science teacher says an educational video site is blocked in the classrooms. Can it be allowed for teachers only?",
        steps: [
            ["r", 1, "Hi Paul, I have reviewed the site and added it to the allowed list for the teachers' group. It may take a few minutes to take effect.", 15],
            ["c", 2, "Working for the teachers. Thanks."],
        ],
        survey: [5, "Great service."],
    },
    {
        cust: 5, contact: 0, host: "MGA-ADMIN-01", subject: "Registrar PC prints to the wrong printer", pri: "low", status: "open", age: 18, who: null, via: "portal", queue: 0, tags: ["printing"],
        desc: "Since Monday everything I print goes to the library printer instead of my office printer.",
        steps: [],
    },
    {
        cust: 5, contact: 3, subject: "Lab account password reset", pri: "low", status: "closed", age: 430, who: 1, via: "tray", queue: 0, tags: ["accounts"],
        desc: "A student locked their lab account and the teacher cannot reset it.",
        steps: [
            ["r", 1, "Hi Paul, the account is unlocked and a new temporary password has been sent to the teacher. The student will be asked to choose a new one at sign-in.", 5],
        ],
        survey: [5, ""], kb: [6],
    },
    {
        cust: 1, contact: 3, subject: "Billing question: extra charge on last invoice", pri: "low", status: "resolved", age: 200, who: 2, via: "email", queue: 0, tags: ["billing"],
        desc: "There is a line on last month's invoice for an after-hours visit that I do not recognise. Can you explain it?",
        steps: [
            ["r", 6, "Hi Nora, that line is the Saturday visit to restore the file server on the 12th, as requested by Jonathan. I have attached the ticket history showing the request and the work done.", 10],
            ["c", 26, "Understood, thank you for the detail."],
        ],
    },
    {
        cust: 0, contact: 1, host: "HAR-LAPTOP-04", subject: "Laptop battery drains in two hours", pri: "normal", status: "in_progress", age: 100, who: 0, via: "email", queue: 0, tags: ["hardware"],
        desc: "The practice manager's laptop only lasts about two hours on battery.",
        steps: [
            ["r", 5, "Hi, I ran a battery report: the battery has lost 38% of its capacity and the laptop is still under warranty. I will arrange a replacement battery and ask you for a convenient day.", 20],
            ["n", 30, "Warranty claim submitted, battery arrives Wednesday."],
        ],
    },
    {
        cust: 3, contact: 3, subject: "Invoice question and payment confirmation", pri: "low", status: "resolved", age: 240, who: 2, via: "email", queue: 0, tags: ["billing"],
        desc: "Can you confirm you have received our payment for the invoice from August? We sent a bank transfer last Friday.",
        steps: [
            ["r", 4, "Hi Wendy, I can confirm that the payment arrived on Monday and the invoice is marked as paid. Thank you!", 5],
        ],
    },
];

export const CANNED = [
    ["Request received", "Hi {{requester.name}}, thank you for contacting us. We have your request and a technician will be in touch shortly. If this is urgent, please call the number in your email signature."],
    ["Ready for remote access", "Hi {{requester.name}}, we are ready to connect to your computer. Please save your work and keep the computer switched on. You will see a short notice when we connect."],
    ["Closing a resolved ticket", "Hi {{requester.name}}, we believe this is now resolved. We will close the ticket in three days unless we hear back from you. Reply here if anything is still not right."],
    ["Waiting on you", "Hi {{requester.name}}, we need a little more information to continue. Could you reply with the details above? We have paused the clock until we hear from you."],
] as const;

export const TEMPLATES = [
    { name: "New starter", hint: "Account, laptop and access for a new employee", subject: "New starter: ", body: "Name:\nStart date:\nJob title:\nManager:\nEquipment needed:\nSoftware and shared drives needed:", priority: "medium" },
    { name: "Hardware request", hint: "Monitor, keyboard, headset, dock", subject: "Hardware request: ", body: "What do you need?\nWho is it for?\nWho approves the cost?", priority: "low" },
    { name: "Software install request", hint: "A program to install on one computer", subject: "Install software: ", body: "Program name and version:\nComputer name:\nBusiness reason:\nLicence available? (yes/no)", priority: "low" },
    { name: "Something is broken", hint: "A problem with a computer, printer or network", subject: "", body: "What is not working?\nWhen did it start?\nWhat have you tried?\nIs anyone else affected?", priority: "medium" },
] as const;
