# Unattended Remote Console

Remote Console works with nobody at the device, including when nobody is signed in. A technician can
see and use the sign-in screen, the lock screen and UAC prompts.

## How it works

The agent service runs as SYSTEM and starts the capture helper as SYSTEM in the session on screen:

1. A signed-in session that is active, at the console first, then over Remote Desktop.
2. Otherwise the console's sign-in screen.

The helper attaches to whichever desktop is receiving input. If what is on screen moves to another
session, for example when someone signs in, the agent starts a new helper there and the picture continues.

If the helper cannot start as SYSTEM, the agent falls back to starting it as the signed-in user, which
shows the normal desktop but not the secure screens. With nobody signed in, that fallback has nothing to show.

## Security

- **Signing in still needs a password.** This shows the sign-in screen, and does not bypass it.
- **UAC prompts can be answered**, with the rights of the signed-in user. A technician can approve a prompt
  for a user who is an administrator, and that is the purpose of showing them.
- **Nothing a user can type into runs as SYSTEM.** The chat window runs in a separate helper, as the user.
- **The pipe to a SYSTEM helper only admits SYSTEM and Administrators**, and the helper proves itself with a
  secret created for that session.
- **A SYSTEM helper never outlives its session.** Closing the pipe tells it to exit, and it is ended if it does not.
- **There is no prompt or banner at the device.** Anyone at the screen is not told that a session has started.
  Check this is acceptable where you deploy it, and whether your customers or local law require notice.

## Ctrl+Alt+Del

Windows ignores those keys when a program types them, so the viewer has a button that uses `SendSAS`. Windows
only allows this if the `SoftwareSASGeneration` policy permits services. The agent turns that on for a few
seconds around the call and restores the previous value. It reaches the console session only, not Remote Desktop.
