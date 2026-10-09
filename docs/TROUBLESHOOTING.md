# Troubleshooting

Every message the app can show you, what it means, and what to do. If you only have time for one
thing: open the Debug view, read **Discord CDP Diagnostics**, and check
[USAGE.md](USAGE.md#connect-to-the-discord-client-cdp) — most failures are "the client is not
actually connected", not a bug.

## Table of contents

- [How to read an error](#how-to-read-an-error)
- [Most common problems](#most-common-problems)
- [CDP endpoint probe states](#cdp-endpoint-probe-states)
- [CDP runtime statuses](#cdp-runtime-statuses)
- [Error codes](#error-codes)
- [Simulation refusals](#simulation-refusals)
- [Login and token problems](#login-and-token-problems)
- [Quest-specific problems](#quest-specific-problems)
- [Startup, packaging and antivirus](#startup-packaging-and-antivirus)
- [Platform-specific](#platform-specific)
- [Filing a useful bug report](#filing-a-useful-bug-report)

## How to read an error

Codes in `snake_case` (`cdp_readiness_timeout`, `launch_task_failed`) come from the Rust backend:
they name the stage that failed, and the message usually carries parameters — a port, a timeout, a
count. Codes in `SCREAMING_CASE` (`SIMULATION_PLATFORM_UNSUPPORTED`) come from quest startup and are
about the game, not your connection.

The app's own **Discord CDP Diagnostics** panel separates four different questions, and keeping them
apart is what makes diagnosis possible:

1. **Is the port answering?** — an HTTP endpoint on `127.0.0.1:<port>` that returns a target list.
2. **Is a Discord renderer in that list?** — the endpoint existing is not the same as a usable client.
3. **Do we own the process behind it?** — a validated running installation, not just a title that
   says Discord.
4. **Can this operation run?** — the methods a specific quest needs, in the specific frame it needs.

Four different failures, four different fixes. "CDP is broken" is almost never the real answer.

## Most common problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Not connected - Start Discord with debug flag" | Discord was launched normally, so no debug port exists | **Settings → Discord Integration → Launch Discord with CDP**, and accept the restart prompt |
| Auto-detect finds no account | Discord is in a non-standard location, or the channel is not one the scanner reads | Use CDP login, or add the installation path in **Settings → Discord Integration** |
| CDP connects but quests never progress | The connected client is not the one holding your session, or client info is stale | Confirm the client/installation picker, press **Sync Discord Client Info via CDP**, then re-read the Debug panel |
| A game quest refuses to start | The title has no Windows-process identity to simulate on your OS | Accept the offered **Switch to CDP and retry** |
| An Activity quest cannot find its window | The Activity was never launched, or the frame belongs to another client | Launch the Activity in Discord first; if it is already open, restart the client |
| Every accept fails, or a red banner names a deadline | Discord enrollment cooldown on the account | Wait for the deadline shown. Running quests are unaffected |
| Quests stopped when the machine slept | Keep-awake covers Windows and macOS only | Enable idle inhibition in your Linux compositor |
| Five parallel quests feel slow | Deliberate 600 ms per-route pacing that prevents one `429` from stopping everything | Lower parallelism or the submission interval if you prefer fewer, slower requests |

## CDP endpoint probe states

These strings appear in the diagnostics panel and in `cdp_readiness_timeout` parameters as
`lastStatus`.

| State | Meaning | What to do |
| --- | --- | --- |
| `unreachable` | Nothing is answering on that port | Launch the client with CDP, or fix the port in **Settings → Advanced** |
| `occupiedNonCdp` | A different service owns the port | Free the port or choose another one; the app tells you which one it tried |
| `cdpWithoutDiscordTarget` | A DevTools endpoint answers, but no Discord page target is in it | The client is starting, crashed, or you are pointed at the wrong installation. Restart the client with CDP |
| `discordReady` | A Discord renderer is present and reports ready | If something still fails at this point, it is not connectivity — look at the runtime status below |

## CDP runtime statuses

`runtimeStatus` answers "can we actually drive this renderer?".

| Status | Meaning | What to do |
| --- | --- | --- |
| `ready` | Verified: the environment, native bridge and focus checks all passed | Not the problem; read the operation's own error code |
| `loading` | The client has not finished starting | Wait and retry — the app already is, up to its deadline |
| `unsupported` | This renderer does not expose what the operation needs | Usually a Vesktop build without the native bridge, or a client too old. Update, or use the official client for that quest type |
| `probeFailed` | The probe itself did not answer, or answered while still reporting itself as not ready | Retries are bounded and then the target is dropped; restart the client if it repeats |
| `noCandidate` | No candidate target was found | Not proof CDP is off: if the only target is the updater, the client simply has not opened its main window yet |

The companion booleans tell you which check failed: `webSocketReachable`, `appRootPresent`,
`moduleLoaderPresent`, `nativeBridgePresent`, `focused`, plus `failureStage` and `reasonCode` (for
example `runtime_not_loaded`).

## Error codes

| Code | Plain meaning | What to do |
| --- | --- | --- |
| `cdp_readiness_timeout` | The client did not become usable inside the wait (30 s by default). The parameters name the port, the last probe state, and how many targets were found | If `lastStatus` is `cdpWithoutDiscordTarget`, restart the client with CDP. If targets exist but none qualified, the client is running but not logged in or not the selected installation |
| `cdp_capability_missing` | This specific operation needs an SDK method the client does not expose; the message lists the missing names | Not a connectivity problem and not fixed by changing pages. Update the client, or switch that quest to the other mode |
| `cdp_target_invalidated` | The renderer we were driving closed or reloaded mid-operation | Expected when you close or reload Discord during a quest. Start the quest again after the client settles |
| `cdp_probe_failed` | A single runtime probe failed outright | Look at the probe's own detail in the diagnostics panel; usually the client was busy or restarting |
| `cdp_runtime_unavailable` | "Client runtime verification failed" — the environment that makes a target a Discord client is missing | A title or URL claiming to be Discord does not qualify an updater, a blank page, or an ordinary web page. Select the real main window |
| `cdp_port_occupied` | Another service holds the CDP port | Free the port or set a different one in **Settings → Advanced** |
| `runtime_not_loaded` | The target answered but its Discord runtime was not up yet | Retry once the client finishes loading |
| `launch_failed` | The client could not be started at all | Check the installation path in **Settings → Discord Integration**; make sure the client is not mid-update |
| `launch_task_failed` | The launcher sidecar process itself errored | Confirm `waybridge` sits next to the executable (portable builds), then retry the launch |
| `noCandidate` with only an updater target | The client is updating, not CDP-disabled | Let the update finish; if it repeats, see `cdp_readiness_timeout` |

## Simulation refusals

These are the app declining to pretend, which is better than reporting progress that will never
count.

| Code | Message you see | Reality |
| --- | --- | --- |
| `SIMULATION_EXECUTABLE_OS_UNSUPPORTED` | "{game} only provides a Windows executable, which can't be process-simulated on Linux" | Switch to CDP mode — the app offers the button |
| `SIMULATION_EXECUTABLE_NOT_FOUND` | "{game} has no compatible executable for simulation mode" | Switch to CDP mode |
| `SIMULATION_PLATFORM_UNSUPPORTED` | "{game} only runs on consoles, which this app cannot simulate" | No workaround exists. Play it on a console; Discord records the progress itself |

## Login and token problems

| Symptom | Cause | Fix |
| --- | --- | --- |
| Token works in the browser but not here | A token copied from DevTools is not the same thing as the local client's stored credential | Use Auto Detect or CDP login; if you must paste, paste the account token, not a session cookie |
| Everything fails after you changed your password or logged out elsewhere | The stored token is gone | Sign in again in the app |
| "Client launch was cancelled. No account was logged in." | You dismissed the CDP launch dialog | Re-run the login, or connect manually via **Settings → Discord Integration** |
| Requests rejected with Discord `400`-style errors while the token is valid | Stale client properties (`super properties`) for your client build | Update the app; check **Debug → super properties** against your client version |

## Quest-specific problems

**A video quest is not enrolling.** The video path checks enrollment before submitting progress, so a
quest enrolled elsewhere, or an account on cooldown, shows an explicit failure instead of a silent
loop. Accept the quest in Discord, then retry.

**A game never gets detected while simulating.** Discord has to have the game in its index. Check
**Settings → Quest Behavior → simulation directory**, then use **Debug → Discord Running Games** to
see what Discord's own detector reports — that panel is read-only, so it tells you whether the
problem is our simulation or Discord's indexing.

**An Activity quest says the Activity was never launched.** The app waits for the Activity iframe and
then names which miss happened: no activity target and no iframe in the window means the Activity was
never started in the client you attached to; a frame present but never listed by the target list
needs a client restart; iframes belonging to other hosts means you are attached to the wrong client —
the message names the hosts so you can tell. If the window reports iframes but none has a source yet,
the message says the frame may still be mounting: wait a moment and retry.

**A quest shows 99% for a long time.** Correct behavior — the last step is Discord marking it
completed, and we do not display 100% before that happens. See
[USAGE.md](USAGE.md#how-progress-is-counted) for why some quests count checkpoints instead of
seconds.

**Nothing claims the reward.** Claiming is Discord's action; the app exposes **Claim Reward** only once
the API reports the quest complete. Rewards needing a browser flow redirect the client to the quest
page and ask you to finish there.

## Startup, packaging and antivirus

| Symptom | Cause | Fix |
| --- | --- | --- |
| SmartScreen "Windows protected your PC" | Unsigned binary | **More info → Run anyway** after confirming the source |
| Defender deleted the file | Heuristic flag on credential reading + process identity rewriting | Restore from quarantine, add the app folder to exclusions |
| VirusTotal shows 1–3 engines flagging it | `PUA`/`Generic ML` verdicts from machine-learning engines, not a matched signature | Expected. A much higher count is not expected — stop and open an issue |
| Portable build starts but CDP launch fails | `waybridge.exe` is not next to the main executable | Put it back in the same folder |
| macOS says the app is damaged | Quarantine on an unsigned build | `xattr -cr "/Applications/Auto Quest Complete Discord.app"` |

## Platform-specific

| Platform | Symptom | Fix |
| --- | --- | --- |
| Linux | Blank window, especially in a VM | WebKitGTK accelerated compositing. The app falls back for known cases; if it persists, launch with `WEBKIT_DISABLE_COMPOSITING_MODE=1` |
| Linux | AppImage exits with `dlopen(): error loading libfuse.so.2` | Install `libfuse2`, or use the `.deb` |
| Linux | Machine sleeps mid-quest | Keep-awake is intentionally not implemented here; configure compositor idle inhibition |
| Windows | No window at all on an old install | The Evergreen WebView2 runtime is missing; install it or update Windows |
| Any | Mobile Discord | Not supported. The app attaches to the desktop client over CDP, which the mobile apps do not expose |

## Filing a useful bug report

Include:

1. The exact error code and message text.
2. **Settings → Diagnostics → export logs** output (tokens and account data are redacted — do not
   paste raw ones).
3. Your OS, the app version from **Settings → About**, and which Discord client and installation you
   are connected to.
4. Whether the same action works on a different quest, and what **Debug → Discord CDP Diagnostics**
   shows at the moment of failure.

Open an issue at <https://github.com/ninokiru/Auto-Quest-Complete-Discord/issues> using the bug
report template.
