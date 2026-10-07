<div align="center">

<h1>Auto Quest Complete Discord</h1>

<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Auto Quest Complete Discord logo" width="150">
</p>

<p><strong>🎮 Automate your Discord Quests with one click</strong></p>

<p>Complete Discord video, stream, and game quests automatically while you focus on what matters.</p>

<p>⭐ <strong>If you find this helpful, please give it a star!</strong> ⭐</p>

[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue.svg)](https://github.com/ninokiru/Auto-Quest-Complete-Discord/releases)
[![Tauri](https://img.shields.io/badge/tauri-2-blue.svg)](https://tauri.app/)
[![Vue](https://img.shields.io/badge/vue-3.5-green.svg)](https://vuejs.org/)
[![Rust](https://img.shields.io/badge/rust-1.70%2B-orange.svg)](https://www.rust-lang.org/)
[![GitHub Release](https://img.shields.io/github/v/release/ninokiru/Auto-Quest-Complete-Discord?label=latest%20release&color=41b883)](https://github.com/ninokiru/Auto-Quest-Complete-Discord/releases/latest)

<br>

<img src="public/certificated-ai-sloop-tiny.png" alt="Certificated AI Slop" width="480">

</div>

## 🚀 Quick Start

> [!WARNING]
> **This tool is for educational purposes only.** Using this tool may violate Discord's Terms of Service. The authors are not responsible for any consequences resulting from the use of this software. Use at your own risk.

### Download & Run

Download the latest build from [GitHub Releases](https://github.com/ninokiru/Auto-Quest-Complete-Discord/releases/latest).

| Platform | Release file | Instructions |
| --- | --- | --- |
| Windows x64 Installer | `auto-quest-complete-discord-Windows-x64-<version>-setup.exe` | Run the NSIS installer. |
| Windows x64 Installer (MSI) | `auto-quest-complete-discord-Windows-x64-<version>-setup.msi` | Open the MSI installer, e.g. for scripted deployment with `msiexec`. |
| Windows x64 Portable | `auto-quest-complete-discord-Windows-x64-<version>-portable.zip` | Extract the ZIP and run `auto-quest-complete-discord.exe`; keep `waybridge.exe` beside it. |
| macOS Apple Silicon Installer | `auto-quest-complete-discord-MacOS-arm64-<version>.dmg` | Open the DMG and drag the app to Applications. If macOS blocks it, run the quarantine-removal command below. |
| macOS Apple Silicon Portable | `auto-quest-complete-discord-MacOS-arm64-<version>.zip` | Unzip and move `Auto Quest Complete Discord.app` to Applications. |
| Linux x86_64 Installer | `auto-quest-complete-discord-Linux-x86_64-<version>.deb` | Install the Debian package with the command below. |
| Linux x86_64 Portable | `auto-quest-complete-discord-Linux-x86_64-<version>.AppImage` | Make the AppImage executable and run it with the commands below. |

Desktop only. Android and iOS are not supported and no build is published for them: the app attaches to the desktop Discord client over Chrome DevTools Protocol, which the mobile apps do not expose.

On macOS, remove the quarantine attribute if needed:

```bash
xattr -cr "/Applications/Auto Quest Complete Discord.app"
```

### Windows Defender and SmartScreen

Releases are **not code-signed** — signing certificates cost money and this project stays free. An unsigned binary that also rewrites its own process identity and reads locally stored credentials looks exactly like malware to heuristic scanners, so Defender may quarantine the download and SmartScreen may show "Windows protected your PC". That is a false positive, not a detected infection.

1. Confirm the file came from this repository's Releases page.
2. On the SmartScreen dialog choose **More info → Run anyway**.
3. If Defender removed the file, restore it from quarantine and add its folder to **Virus & threat protection → Exclusions** before launching again.

Every published build comes from the commit tagged with that version, and the GitHub Actions log for the run is public, so the binary can be traced back to this source tree.

On VirusTotal you will typically see 1-3 of 70 engines report a name like `Generic ML PUA` or `Malicious`. `PUA` means "potentially unwanted application", not a virus, and those verdicts come from machine-learning engines rather than a matched malware signature. The engines that ship signature databases stay silent on the same file. If a build you downloaded shows a much higher count than that, do not run it and open an issue instead.

On Linux, install the Debian package like this:

```bash
sudo apt install ./auto-quest-complete-discord-Linux-x86_64-<version>.deb
```

Or run the portable AppImage like this:

```bash
chmod +x auto-quest-complete-discord-Linux-x86_64-<version>.AppImage
./auto-quest-complete-discord-Linux-x86_64-<version>.AppImage
```

> [!NOTE]
> Release binaries are built and published by GitHub Actions from the repository source. Linux release packages target x86_64; macOS releases currently target Apple Silicon.

### Sign in

1. **Auto Detect Token** — find accounts from supported local Discord profiles.
2. **CDP Login** — connect to the official Discord desktop client or Vesktop.
3. **Manual Input** — enter a token directly when the other methods are unavailable.

> [!TIP]
> Vesktop is supported through CDP only; it is not scanned as a local token source. You can select a detected installation or add a custom/portable `vesktop.exe` in Settings.

### Complete Quests

- **Video/Stream:** Click **Start Quest** on an incomplete quest.
- **Game:** Open **Game Simulator**, select a game, then create and run a simulated game.

## ✨ Features

- ⚡ **Flexible Login** — Auto-detect supported local Discord profiles, connect through CDP, or enter a token manually.
- 🖥️ **Discord & Vesktop Support** — Select the desktop client or installation used for CDP login, including custom paths.
- 🐧 **Linux Desktop Support** — Available as an x86_64 AppImage or Debian package.
- 🎮 **Zero-Download Game Simulation** — Complete game quests without downloading or installing the actual game.
- 📺 **Video & Stream Automation** — Start once and let quest progress update in the background.
- 🔀 **Parallel Quests** — Run up to five quests at the same time and stop any single one of them.
- 🔍 **Advanced Quest Filters** — Filter by reward type, completion status, and more.
- 👥 **Multi-Account Support** — Manage multiple Discord accounts in one app.
- 🌏 **Multi-language** — English, Vietnamese, Simplified Chinese, Traditional Chinese, Japanese, Korean, Russian, Spanish, German, French, Indonesian, Polish, Brazilian Portuguese, European Portuguese, Thai, and Turkish.

## 📸 Screenshots

| Login | Home |
|:-----:|:----:|
| ![Login](https://github.com/user-attachments/assets/a67369e9-7bd5-46ca-afdc-f16e54f64824) | ![Home](https://github.com/user-attachments/assets/bde65569-c4e0-4d0e-971a-a28ab9f38468) |

| Multi-Account | Game Simulator |
|:-------------:|:--------------:|
| ![Multi-Account](https://github.com/user-attachments/assets/0abcfd9e-5716-451a-ba5e-bac38b7324f5) | ![Game Simulator](https://github.com/user-attachments/assets/d1f9d481-39f6-4bef-8b4a-9bf90c9ad4e3) |

| Quest Progress | Settings |
|:--------------:|:--------:|
| ![Quest Progress](https://github.com/user-attachments/assets/7a1d6c82-63a6-4595-a060-cefae05676e5) | ![Settings](https://github.com/user-attachments/assets/1261a2f5-8b99-4c55-ab7e-18e7b9617e8e) |

## 🏗️ Architecture

```text
Auto Quest Complete Discord
├─ Vue 3 + Vite frontend
│  ├─ Views: Home, Game Simulator, Settings, Debug
│  ├─ Pinia stores and composables for auth, quests, settings, and UI state
│  └─ src/api/tauri.ts — typed Tauri IPC client
│
├─ Tauri 2 Rust application
│  ├─ Discord API and Gateway integration
│  ├─ CDP client and quest execution for video, stream, activity, and game quests
│  ├─ Official Discord and Vesktop providers for discovery, launch, and process supervision
│  ├─ Token extraction and platform capability detection
│  ├─ Game simulation and manual CDP game sessions
│  └─ Runtime identity auditing and platform runtime bridge management
│
├─ Workspace crates
│  ├─ discord-cdp-launch-core — cross-platform client discovery and launch core
│  ├─ src-cdp-launcher — optional Discord/Vesktop CDP launcher sidecar
│  └─ src-runner — minimal game-process runner sidecar
│
└─ Discord services
   ├─ REST API — quests, accounts, rewards, and profile data
   ├─ Gateway — account and activity events
   └─ Discord/Vesktop CDP targets — browser automation and session capture
```

The frontend communicates with the Rust backend through Tauri IPC. The backend owns Discord networking, local credential extraction, CDP sessions, quest execution, process cleanup, and platform-specific integration.

Explore the codebase with [![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/ninokiru/Auto-Quest-Complete-Discord)

## 🔒 Security

- **Tokens are kept in memory by the helper** — The app does not intentionally persist your Discord token to disk.
- **Encrypted local extraction** — Auto-detection reads supported Discord profiles through platform-native protection where available.
- **Platform-native credentials** — Windows DPAPI, macOS Keychain, and Linux Secret Service are used by the local extraction paths.
- **HTTPS for Discord API requests** — Network requests use secure HTTPS connections.
- **Sanitized diagnostics** — Logs and debug exports redact sensitive tokens and account data where applicable.

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for:

- Development setup
- Project structure
- Code conventions
- Pull request guidelines

## 📄 License

GNU General Public License v3.0 only — see the [LICENSE](LICENSE) file.

In practice this means you are free to use, study, change, and redistribute this app, but **any derivative you distribute must stay under GPL-3.0 with its complete source code available**, and it must carry the same notice that it comes without warranty. Building your own private copy for yourself has no such obligation.

Contributions to this repository are licensed under GPL-3.0-only as well.


## 🙏 Credits

**Forked from**

- `discord-quest-helper` by Masterain (MIT licensed) — this repository is a renamed continuation of that project, maintained as **Lumina** under `ninokiru/Auto-Quest-Complete-Discord` and starting again at `0.0.1`. Upstream authorship of the original project remains credited to Masterain. MIT permits the code it covers to be redistributed under a copyleft license, so this fork is released under GPL-3.0-only; the original MIT notice stays published in that project's own repository.

**Inspiration & Resources**
- [markterence/discord-quest-completer](https://github.com/markterence/discord-quest-completer)
- [power0matin/discord-quest-auto-completer](https://github.com/power0matin/discord-quest-auto-completer)
- [taisrisk/Discord-Quest-Helper](https://github.com/taisrisk/Discord-Quest-Helper)
- [aamiaa/CompleteDiscordQuest.md](https://gist.github.com/aamiaa/204cd9d42013ded9faf646fae7f89fbb)
- [docs.discord.food](https://docs.discord.food/)

**Technologies**
- [Tauri](https://tauri.app/) • [Vue.js](https://vuejs.org/) • [Pinia](https://pinia.vuejs.org/) • [vue-i18n](https://vue-i18n.intlify.dev/) • [shadcn-vue](https://www.shadcn-vue.com/) • [TailwindCSS](https://tailwindcss.com/) • [Lucide Icons](https://lucide.dev/)
