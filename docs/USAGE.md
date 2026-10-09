# Using Auto Quest Complete Discord

What the app does, in the order you will actually do it: install, sign in, connect to your Discord
client, run a quest, collect the reward, and keep it running while you use the computer normally.

The app automates Discord's Quests page for one account at a time per window, up to five quests in
parallel. It runs entirely on your machine: no server of ours, no telemetry, no subscription.

> [!WARNING]
> Quest automation is not what Discord's Quests page is designed for and may violate its Terms of
> Service. Consequences can range from the quest feature being disabled to the account being
> disabled. Use an account you are prepared to lose. Nothing here unlocks purchases, payments, or
> any other Discord surface — the app only touches quests.

## Table of contents

- [Before you start](#before-you-start)
- [Install](#install)
- [Sign in](#sign-in)
- [Connect to the Discord client (CDP)](#connect-to-the-discord-client-cdp)
- [Read the quest list](#read-the-quest-list)
- [Run each kind of quest](#run-each-kind-of-quest)
- [How progress is counted](#how-progress-is-counted)
- [Batch actions and parallelism](#batch-actions-and-parallelism)
- [Run it in the background](#run-it-in-the-background)
- [Settings reference](#settings-reference)
- [Diagnostics](#diagnostics)
- [Where your data lives](#where-your-data-lives)
- [Updates](#updates)

## Before you start

| Requirement | Why |
| --- | --- |
| Windows 10 or 11 (x64) for the published build | Releases currently publish Windows x64 only. macOS and Linux work from source — see [BUILDING.md](BUILDING.md) |
| A Discord desktop client on the same machine | CDP login, Activity quests, and game quests in CDP mode all drive the local client. Discord Stable, PT, Canary, and Vesktop are supported; Vesktop over CDP only |
| WebView2 runtime | Ships with current Windows 10/11 installs |
| An account you accept risk on | See the warning above |

You do **not** need administrator rights, and you do not need to download any quest's game.

## Install

Download from [GitHub Releases](https://github.com/ninokiru/Auto-Quest-Complete-Discord/releases/latest).

| File | How to use it |
| --- | --- |
| `auto-quest-complete-discord-Windows-x64-<version>-setup.exe` | Normal install. Run it and launch from the Start menu |
| `auto-quest-complete-discord-Windows-x64-<version>-portable.zip` | Extract and run `auto-quest-complete-discord.exe`. **Keep `waybridge.exe` in the same folder** — it is the CDP launcher sidecar, and without it the app cannot start Discord with a debug port |

### SmartScreen and Defender

The binaries are unsigned, and the app does two things heuristic scanners dislike: it reads the
login token the local Discord client stored, and it adjusts its own process identity so Discord's
client detection accepts a simulated game. Expect a SmartScreen prompt and possibly a Defender
quarantine on first run. That is a false positive, not a detected infection.

1. Confirm the file came from this repository's Releases page.
2. On "Windows protected your PC" choose **More info → Run anyway**.
3. If Defender removed the file, restore it from quarantine and add its folder to
   **Virus & threat protection → Exclusions** before launching again.

## Sign in

Pick any of the three. All three end up with the same thing — an account loaded into the window —
and none of them sends your credentials anywhere except Discord's own API.

| Method | What it needs | Notes |
| --- | --- | --- |
| **Auto Detect Token** | Discord installed in a standard location | Scans supported local profiles and decrypts the stored token using the platform's own credential protection (Windows DPAPI, macOS Keychain, Linux Secret Service). Fastest when it works |
| **CDP Login** | The Discord or Vesktop client running with a debug port | Uses the account you are already signed in to; no token is read from disk. If no client is running with CDP, the app offers to launch or restart one for you |
| **Manual Input** | Nothing | Paste a token yourself. Works when the other two cannot, but a token stops being usable whenever you log out or reset it, and you have to obtain it without help |

The token is held in memory by the helper process; the app does not write it to disk.

Vesktop is supported through CDP only — it is not scanned as a token source. Choose which client and
which installation to use in **Settings → Discord Integration**, including a custom or portable path.

## Connect to the Discord client (CDP)

CDP — Chrome DevTools Protocol — is the debugging interface the Discord desktop client (being an
Electron app) exposes when started with `--remote-debugging-port`. The app uses it to log in, to
launch Activities, and to inject a "playing" state.

1. **Settings → Discord Integration**.
2. Confirm the client and installation are the ones you actually use. The default port is **9223**;
   change it under **Settings → Advanced** if something else on your machine owns that port.
3. Press **Launch Discord with CDP**. If Discord is already running normally, you get a confirmation
   dialog first, because enabling the port means restarting the client.
4. When the client comes back, **CDP status** in the same panel should read **Connected**. Use
   **Sync Discord Client Info via CDP** to pull the client's version and build data.

Restarting the client closes your call, your screen share, and any Discord Activity in progress. Do
it deliberately, not mid-quest.

If the panel says **"Not connected - Start Discord with debug flag"**, the client was launched
normally — step 3 is the fix. Detailed codes are in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Read the quest list

Home lists the quests available to the signed-in account, with the reward, the task type, the
deadline, and a status.

- **Views**: Recommended, To Accept, Ready to Run, Ready to Claim, Completed, All.
- **Filters**: by quest type, reward type, completion state and expiry. **Search** is free text over
  title and game name. Filter choices are saved and restored next time.
- **Accept first.** A quest you have not accepted cannot be started; **Accept All** does the batch.
- Expired quests are hidden by default so the list stays readable; you can show them to inspect them.
- A **red banner naming a date and time** means Discord has put the account on an enrollment
  cooldown — you cannot accept new quests until then. Quests already running are unaffected, and the
  banner clears on its own when the deadline passes.

## Run each kind of quest

### Video and stream quests

1. Find the quest whose task is to watch a video or stream.
2. Press **Start Quest**.
3. The app enrolls you and submits progress on a timer until the required duration is reached.
   Default submission interval is 15 s at 1.0x speed; both are adjustable in
   **Settings → Quest Behavior**.

Nothing needs to be clicked to finish it, and nothing needs to stay visible. Your status can show the
activity while it runs.

### Game quests — two modes

A "play the game" quest expects Discord to see the game running. You have two ways to give it that.

**Simulate mode (default, no download).**

1. Open **Game Simulator**.
2. Select the game from the list.
3. Create and run the simulated game. The app launches its own tiny process (the runner) with the
   identity Discord expects, so the quest counts real playtime without the game existing on disk.

**CDP injection mode.** Use it when the title has no compatible executable — the app tells you which
by naming the game and offering **Switch to CDP and retry**.

1. **Settings → Quest Behavior → game quest mode → CDP injection**.
2. Confirm the client is connected over CDP.
3. Start the quest; the playing state is injected into the running client instead of simulating a
   process.

Some quests only count play on a console. The app cannot simulate a console and says so instead of
pretending to progress — play those on the console itself and Discord will record it.

### Activity quests (play inside Discord)

1. Press **Launch Activity**. Discord opens the quest's Activity page.
2. Follow the four-step prompt in Discord and launch the Activity there, once.
3. Back in the app, press **Start Quest**. The app takes over progress reporting for that session.

If the app cannot find the Activity frame, it names the reason: the Activity was never launched, the
client needs a restart, or the window belongs to a different client than the one you connected to.

### Claiming

The app never marks a quest claimed until Discord's own API agrees. When a quest is done, it shows
**Claim Reward**; rewards that require a browser flow redirect the Discord client to the quest page
and ask you to finish there yourself.

## How progress is counted

This is the most commonly misread part of the interface, so it is worth stating plainly:

| Task | What "target" means | What the card shows |
| --- | --- | --- |
| Play / stream / video quests | **Seconds** of activity | A time-formatted pair, e.g. `1:30 / 3:00` |
| `ACHIEVEMENT_IN_ACTIVITY` quests | **Checkpoints** inside the Activity | A count, e.g. `2 / 3` |

A checkpoint quest with three checkpoints is *not* three seconds of work. Each running quest carries
its own unit, which is why you can see one quest moving by time and another moving by count at the
same time.

Live quests also stop displaying at **99%** until Discord reports the quest completed. That is not a
stall: the last tick is Discord's, not ours, and showing 100% before Discord agreed would be a lie
about a reward you had not earned yet.

## Batch actions and parallelism

- **Batch actions**: Accept All, Complete All Video Quests, Complete All Game Quests, Complete All
  Quests, Stop Queue.
- **Five quests run at once.** Anything beyond that waits in a queue and starts as a slot frees. You
  can stop any single quest without touching the others.
- Requests are **paced per API route with a 600 ms gap**, and a `429` rate-limit response holds the
  whole route rather than each slot collecting its own. Batch actions are therefore about 0.6 s
  slower per quest than an unpaced client would be. That is deliberate: it is what stops Discord from
  throttling the entire set because one quest moved too fast.

## Run it in the background

- **Keep-awake**: while at least one quest is running, the app asks the operating system not to sleep
  and releases that request as soon as nothing is running. Windows uses `SetThreadExecutionState`,
  macOS uses `caffeinate` bound to the app's process so it dies with the app. **Linux does nothing** —
  turn on idle inhibition in your compositor or the machine can sleep mid-quest.
- **Notifications**: an OS notification when a quest finishes or fails, worded in the language the
  app is currently displaying. There is no toggle for it yet.
- Hiding or minimizing the window does not stop anything. Closing the app does, and if a quest is
  running you will be asked before the CDP session is torn down — **Cancel** leaves everything running.

## Settings reference

| Section | What it controls |
| --- | --- |
| **Account** | Signed-in account, login method, manual token entry, token storage note |
| **Quest Behavior** | Video completion speed (0.1x–2.0x, default 1.0x), video progress submission interval (10–30 s, default 15 s), game progress polling interval (30–300 s, default 120 s), game quest mode (Simulate or CDP injection), simulation directory, Orb/Nitro display toggle |
| **Discord Integration** | Client and installation picker (Discord Stable/PT/Canary, Vesktop, custom path), CDP connection state, launch or restart the client with the debug port, sync client info over CDP |
| **Appearance** | Light/dark theme and language. 16 languages; the language follows your system setting on first run |
| **Diagnostics** | Export this session's sanitized logs |
| **Advanced** | CDP debug port (default 9223), developer mode, legacy recovery options |
| **About** | Version, license, and what the app does |

**Settings → Overview** shows the current state of the account, client integration and version, and
points at anything that needs attention.

## Diagnostics

The **Debug** view is for finding out what the app can actually see:

| Panel | What it tells you |
| --- | --- |
| Token / session | Whether a token is loaded, and the session ids generated for this launch |
| Super properties | The request-header properties the app sends to Discord — a stale value here explains `400`-style rejections |
| Embedded Runner | Whether the runner binary is built, its commit, size and build time |
| Discord Running Games | Read-only snapshot of Discord's own game detector: what it thinks is running, its warnings, and the raw `RunningGame` objects |
| Network Header Capture | Statistics from intercepting the client's HTTP requests over CDP, for comparing our requests against Discord's |
| Discord CDP Diagnostics | The live CDP state: which targets were found, which was selected, and why |
| Release baseline | Whether this build's packaged identity matches the release baseline |

**Export logs** (or **Settings → Diagnostics**) writes this session's log with tokens and account
data redacted. Attach that file to a bug report; never attach a raw token, cookie, or
`authorization` header.

## Where your data lives

Settings, quest history and cached state are stored under the application identifier
`com.ninokiru.auto-quest-complete-discord`:

| OS | Path |
| --- | --- |
| Windows | `%APPDATA%\com.ninokiru.auto-quest-complete-discord` |
| macOS | `~/Library/Application Support/com.ninokiru.auto-quest-complete-discord` |
| Linux | `~/.config/com.ninokiru.auto-quest-complete-discord` |

Discord tokens are not written there. Deleting the folder is the reset button: it signs you out,
forgets the accounts and history, and restores default settings. Because this fork stores settings
under a new identifier, upgrading from the old `discord-quest-helper` name means signing in once
again.

## Updates

The app compares its own version against the latest GitHub release and shows a banner with a link
when a newer build exists. It does not download or install anything by itself. Version numbers in
this fork started again at `0.0.1`, so they do not line up with the old project's numbering.

## What this app does not do

By design there is no code for store purchases, billing or payment sources, virtual-currency
redemption, ad-context fields, experiment flags, bulk guild joining, or `X-Fingerprint` /
`X-Installation-ID` headers. Quest automation is the whole scope, and anything that would widen it is
out of scope rather than a TODO.
