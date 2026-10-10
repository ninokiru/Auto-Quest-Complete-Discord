//! In-app update for the Windows build: download the published NSIS installer,
//! check its SHA-256 against the digest GitHub reports for that asset, then hand
//! the install and relaunch to a detached helper so this process can quit first.
//!
//! Built from crates already in the tree (`reqwest`, `sha2`, `serde`) rather than an
//! updater plugin: CI compiles with `--locked`, and a plugin would additionally need
//! a signing key plus repository secrets this project does not have. The guarantee
//! this buys is worth stating plainly — the digest proves the bytes match what
//! GitHub's API reported for that release, not that a known author signed them.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::ipc::Channel;

/// Releases of this repository, addressed by tag.
const RELEASE_TAG_API: &str =
    "https://api.github.com/repos/ninokiru/Auto-Quest-Complete-Discord/releases/tags/";

/// Hosts an installer may legitimately arrive from. GitHub advertises a download on
/// its own host and redirects to a blob host, so both are checked; anything else
/// means the metadata just read is not what it claims to be.
const ALLOWED_DOWNLOAD_HOSTS: &[&str] = &[
    "github.com",
    "codeload.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
];

/// The NSIS bundle is a few megabytes. A much larger response is not the file that
/// was asked for, and holding an unexpected amount of it in memory costs a chance.
const MAX_INSTALLER_BYTES: u64 = 64 * 1024 * 1024;

/// Refuse a second run while one is in flight: two helpers would otherwise install
/// over the same build, the second waiting on a process that never exits.
static UPDATE_ARMED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdatePhase {
    /// Reading the release metadata from GitHub.
    Resolving,
    /// Fetching the installer bytes.
    Downloading,
    /// Hashing what arrived.
    Verifying,
    /// Helper armed; the application closes and the install takes over.
    Installing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub phase: UpdatePhase,
    /// Installer size as GitHub reports it. The byte total only arrives with the
    /// finished response, so this labels the download rather than tracking it.
    pub total_bytes: u64,
}

impl UpdateProgress {
    pub fn phase(phase: UpdatePhase) -> Self {
        Self {
            phase,
            total_bytes: 0,
        }
    }
}

#[derive(Debug, Deserialize)]
struct TaggedRelease {
    tag_name: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    #[serde(default)]
    size: Option<u64>,
    /// GitHub publishes `"sha256:<hex>"` per release asset. Absent means unverifiable.
    #[serde(default)]
    digest: Option<String>,
    browser_download_url: String,
}

/// Characters a release tag may contribute to both a URL path and a file name on
/// disk. Nothing that could leave a directory or start an option.
fn tag_is_safe(tag: &str) -> bool {
    if tag.is_empty() || tag.len() > 64 {
        return false;
    }
    if !tag.starts_with(|c: char| c.is_ascii_digit()) {
        return false;
    }
    for c in tag.chars() {
        if !c.is_ascii_alphanumeric() && !matches!(c, '.' | '-' | '_') {
            return false;
        }
    }
    true
}

/// Drop the leading `v` some tags carry, then validate. The result is used for both
/// the API lookup and the download file name.
fn normalize_tag(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_start_matches('v');
    if !tag_is_safe(trimmed) {
        bail!("The version number is not one this update can install");
    }
    Ok(trimmed.to_string())
}

/// Tauri names an NSIS bundle `<product>-<os>-<arch>-<version>-setup.exe`. Matching
/// on the suffix alone keeps this working when the product name changes.
fn is_windows_installer(name: &str) -> bool {
    let plain = !name.contains('/') && !name.contains('\\');
    plain && name.to_ascii_lowercase().ends_with("-setup.exe")
}

fn pick_installer<'a>(release: &'a TaggedRelease, tag: &str) -> Result<&'a ReleaseAsset> {
    if release.tag_name != tag {
        bail!("GitHub returned a release for a different version than was requested");
    }
    for candidate in &release.assets {
        if is_windows_installer(&candidate.name) {
            return Ok(candidate);
        }
    }
    bail!("This release has no Windows installer to download")
}

/// Read the 64 hex characters that follow `sha256:`. Hand-rolled because no hex
/// codec is a dependency of this crate.
fn parse_sha256_hex(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (index, pair) in hex.as_bytes().chunks(2).enumerate() {
        let high = char::from(pair[0]).to_digit(16)?;
        let low = char::from(pair[1]).to_digit(16)?;
        bytes[index] = (high * 16 + low) as u8;
    }
    Some(bytes)
}

fn expected_digest(asset: &ReleaseAsset) -> Result<[u8; 32]> {
    let Some(published) = asset.digest.as_deref() else {
        bail!("GitHub published no checksum for this installer");
    };
    let Some(hex) = published.strip_prefix("sha256:") else {
        bail!("The published checksum is not SHA-256");
    };
    let Some(digest) = parse_sha256_hex(hex) else {
        bail!("The published checksum is malformed");
    };
    Ok(digest)
}

fn ensure_allowed_host(url: &reqwest::Url) -> Result<()> {
    if url.scheme() != "https" {
        bail!("The installer download is not HTTPS");
    }
    let host = url.host_str().unwrap_or_default();
    let allowed = ALLOWED_DOWNLOAD_HOSTS
        .iter()
        .any(|candidate| host.eq_ignore_ascii_case(candidate));
    if allowed {
        Ok(())
    } else {
        bail!("Refusing to download the installer from {host}")
    }
}

fn http_client() -> Result<reqwest::Client> {
    let version = env!("CARGO_PKG_VERSION");
    let user_agent = format!("Auto-Quest-Complete-Discord/{version} (self-update)");
    reqwest::Client::builder()
        .user_agent(user_agent)
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .context("Could not prepare the HTTPS client")
}

/// Where the verified installer is staged before the helper runs it.
fn installer_path(tag: &str) -> PathBuf {
    let name = format!("auto-quest-complete-discord-{tag}-setup.exe");
    std::env::temp_dir().join(name)
}

async fn fetch_release(client: &reqwest::Client, tag: &str) -> Result<TaggedRelease> {
    let url = format!("{RELEASE_TAG_API}{tag}");
    let accept = "application/vnd.github+json";
    let request = client.get(&url).header("Accept", accept);
    let pending = request.send().await;
    let response = pending.context("Could not reach the GitHub release")?;
    let status = response.status();
    if !status.is_success() {
        bail!("GitHub returned {status} for this release");
    }
    let release = response.json::<TaggedRelease>().await;
    release.context("The release information is unreadable")
}

async fn download_installer(
    client: &reqwest::Client,
    asset: &ReleaseAsset,
) -> Result<reqwest::Bytes> {
    let address = asset.browser_download_url.clone();
    let parsed = reqwest::Url::parse(&address);
    let url = parsed.context("The download address is not a URL")?;
    ensure_allowed_host(&url)?;

    let pending = client.get(url).send().await;
    let response = pending.context("Could not download the installer")?;

    // A redirect can end somewhere other than the address GitHub advertised, so the
    // host that actually served the bytes is checked as well.
    let final_url = response.url().clone();
    ensure_allowed_host(&final_url)?;

    let status = response.status();
    if !status.is_success() {
        bail!("GitHub returned {status} while downloading the installer");
    }

    let pending = response.bytes().await;
    let bytes = pending.context("The download was interrupted")?;
    if bytes.is_empty() {
        bail!("The downloaded installer is empty");
    }
    if bytes.len() as u64 > MAX_INSTALLER_BYTES {
        bail!("The downloaded file is larger than an installer should be");
    }
    Ok(bytes)
}

/// An unverified executable never reaches a path at which something could run, so
/// this is the only way bytes make it to disk here.
fn check_digest(bytes: &[u8], expected: [u8; 32]) -> Result<()> {
    let computed = Sha256::digest(bytes);
    if computed.as_slice() == expected.as_slice() {
        Ok(())
    } else {
        bail!("The installer does not match the checksum GitHub published for it")
    }
}

/// Silent NSIS install, then relaunch. No path from this machine is ever written
/// into the script text: the pid, installer and application arrive as `%~1`, `%~2`
/// and `%~3` arguments, whose batch expansion cmd does not re-parse. The loop gives
/// the running application time to exit, because the installer cannot overwrite an
/// executable that is still loaded, and the counter bounds that wait.
const INSTALLER_SCRIPT_LINES: &[&str] = &[
    "@echo off",
    "set \"WAIT_PID=%~1\"",
    "set /a TRIES=0",
    ":wait",
    "set /a TRIES+=1",
    "tasklist /FI \"PID eq %WAIT_PID%\" /NH 2>nul | find \"%WAIT_PID%\" >nul 2>&1",
    "if errorlevel 1 goto install",
    "if %TRIES% LSS 240 goto pause",
    ":install",
    "\"%~2\" /S",
    "ping -n 4 127.0.0.1 >nul",
    "start \"\" \"%~3\"",
    "del \"%~2\" >nul 2>&1",
    "del \"%~f0\" >nul 2>&1",
    "goto end",
    ":pause",
    "ping -n 2 127.0.0.1 >nul",
    "goto wait",
    ":end",
];

/// `cmd.exe` reads batch files line-wise and does not reliably accept bare-LF
/// scripts, so the helper is written with Windows line endings. The trailing newline
/// keeps `cmd` from dropping a final line that has no terminator.
fn installer_script() -> String {
    let mut script = INSTALLER_SCRIPT_LINES.join("\r\n");
    script.push_str("\r\n");
    script
}

#[cfg(windows)]
fn install_and_relaunch(installer: &Path, app_exe: &Path, script: &str) -> Result<()> {
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let pid = std::process::id().to_string();
    let file_name = format!("auto-quest-complete-discord-update-{pid}.bat");
    let script_path = std::env::temp_dir().join(file_name);
    let written = std::fs::write(&script_path, script);
    written.context("Could not write the update helper script")?;

    std::process::Command::new("cmd.exe")
        .args(["/D", "/C"])
        .arg(&script_path)
        .arg(&pid)
        .arg(installer)
        .arg(app_exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .context("Could not start the update helper")?;
    Ok(())
}

/// Other platforms have no silent installer for this app, so the release page stays
/// the documented path. The command exists everywhere anyway: the frontend learns the
/// platform only after invoking, and an error reads better than a missing command.
#[cfg(not(windows))]
fn install_and_relaunch(_installer: &Path, _app_exe: &Path, _script: &str) -> Result<()> {
    bail!("In-app updates are only available on Windows")
}

fn ensure_supported_platform() -> Result<()> {
    if cfg!(windows) {
        Ok(())
    } else {
        bail!("In-app updates are only available on Windows")
    }
}

async fn perform_update(tag: &str, on_progress: &Channel<UpdateProgress>) -> Result<()> {
    ensure_supported_platform()?;
    let tag = normalize_tag(tag)?;

    let resolving = UpdateProgress::phase(UpdatePhase::Resolving);
    let _ = on_progress.send(resolving);

    let client = http_client()?;
    let pending = fetch_release(&client, &tag).await;
    let label = format!("Could not read release {tag}");
    let release = pending.with_context(|| label)?;
    let asset = pick_installer(&release, &tag)?;
    let expected = expected_digest(asset)?;

    let downloading = UpdateProgress {
        phase: UpdatePhase::Downloading,
        total_bytes: asset.size.unwrap_or(0),
    };
    let _ = on_progress.send(downloading);
    let bytes = download_installer(&client, asset).await?;

    let verifying = UpdateProgress::phase(UpdatePhase::Verifying);
    let _ = on_progress.send(verifying);
    check_digest(&bytes, expected)?;

    let dest = installer_path(&tag);
    let saved = tokio::fs::write(&dest, &bytes).await;
    saved.context("Could not save the verified installer")?;

    let located = std::env::current_exe();
    let app_exe = located.context("Could not locate this application's file")?;

    let installing = UpdateProgress::phase(UpdatePhase::Installing);
    let _ = on_progress.send(installing);
    install_and_relaunch(&dest, &app_exe, &installer_script())
}

/// Arm the update for `tag`: download, verify, stage the helper, and return. The
/// caller then closes the application, which releases the installer's lock on the
/// running executable.
#[tauri::command]
pub async fn start_self_update(
    tag: String,
    on_progress: Channel<UpdateProgress>,
) -> Result<(), String> {
    if UPDATE_ARMED.swap(true, Ordering::SeqCst) {
        return Err("An update is already in progress".to_string());
    }

    match perform_update(&tag, &on_progress).await {
        Ok(()) => Ok(()),
        Err(error) => {
            // Stays armed on success because this process is about to exit; only a
            // failure has to hand the button back to the user.
            UPDATE_ARMED.store(false, Ordering::SeqCst);
            let details = format!("{error:#}");
            crate::logger::log(
                crate::logger::LogLevel::Error,
                crate::logger::LogCategory::General,
                "Self-update failed",
                Some(&details),
            );
            Err(details)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(name: &str, digest: Option<&str>) -> ReleaseAsset {
        ReleaseAsset {
            name: name.to_string(),
            size: None,
            digest: digest.map(str::to_string),
            browser_download_url: "https://github.com/ninokiru/x".to_string(),
        }
    }

    #[test]
    fn accepts_the_tags_this_project_publishes() {
        for tag in ["0.0.3", "0.10.0-rc2", "1.2.3_build4"] {
            assert!(tag_is_safe(tag), "{tag} should be usable");
        }
        assert_eq!(normalize_tag("v0.0.3").unwrap(), "0.0.3");
        assert_eq!(normalize_tag(" 0.0.3 ").unwrap(), "0.0.3");
    }

    #[test]
    fn rejects_tags_that_could_escape_a_path_or_url() {
        let too_long = "9".repeat(65);
        let candidates = [
            "",
            "-setup",
            "../evil",
            "a/b",
            "a\\b",
            "0.0.3;del",
            "0.0.3\".exe",
            too_long.as_str(),
        ];
        for tag in candidates {
            assert!(!tag_is_safe(tag), "{tag:?} must not be accepted");
            assert!(normalize_tag(tag).is_err());
        }
    }

    #[test]
    fn selects_only_the_windows_installer() {
        assert!(is_windows_installer("auto-quest-complete-discord-Windows-x64-0.0.3-setup.exe"));
        assert!(!is_windows_installer(
            "auto-quest-complete-discord-Windows-x64-0.0.3-portable.zip"
        ));
        assert!(!is_windows_installer("setup.exe"));
        assert!(!is_windows_installer("evil/..\\a-setup.exe"));
    }

    #[test]
    fn picks_the_installer_and_insists_the_tag_matches() {
        let installer = "app-Windows-x64-0.0.3-setup.exe";
        let release = TaggedRelease {
            tag_name: "0.0.3".to_string(),
            assets: vec![asset("app-portable.zip", None), asset(installer, None)],
        };

        let chosen = pick_installer(&release, "0.0.3").unwrap();
        assert_eq!(chosen.name, installer);

        // A stale or redirected answer about another version must not be installed.
        assert!(pick_installer(&release, "0.0.4").is_err());

        let empty = TaggedRelease {
            tag_name: "0.0.3".to_string(),
            assets: vec![asset("app-portable.zip", None)],
        };
        assert!(pick_installer(&empty, "0.0.3").is_err());
    }

    #[test]
    fn parses_only_a_full_sha256_hex_string() {
        let hex = "dd20ca839e0b940c33f584b81f51e4e5adb5e40383aca8db3691a0c51791a723";
        let parsed = parse_sha256_hex(hex).expect("a real digest should parse");
        assert_eq!(parsed[0], 0xdd);
        assert_eq!(parsed[1], 0x20);
        assert_eq!(parsed[31], 0x23);

        let repeated = parse_sha256_hex(&"ab".repeat(32)).unwrap();
        assert_eq!(repeated, [0xabu8; 32]);
    }

    #[test]
    fn refuses_malformed_digests() {
        assert!(parse_sha256_hex("").is_none());
        assert!(parse_sha256_hex(&"0".repeat(63)).is_none());
        assert!(parse_sha256_hex(&"0".repeat(65)).is_none());
        assert!(parse_sha256_hex(&format!("{}g", "0".repeat(63))).is_none());
    }

    #[test]
    fn only_a_published_sha256_is_acceptable() {
        let good = format!("sha256:{}", "a".repeat(64));
        assert!(expected_digest(&asset("a-setup.exe", Some(good.as_str()))).is_ok());
        assert!(expected_digest(&asset("a-setup.exe", None)).is_err());
        let md5 = "md5:d41d8cd98f00b204e9800998ecf8427e";
        assert!(expected_digest(&asset("a-setup.exe", Some(md5))).is_err());
        let short = "sha256:deadbeef";
        assert!(expected_digest(&asset("a-setup.exe", Some(short))).is_err());
    }

    #[test]
    fn only_github_hosts_over_https_are_allowed() {
        for host in ALLOWED_DOWNLOAD_HOSTS {
            let text = format!("https://{host}/a/b");
            let url = reqwest::Url::parse(&text).unwrap();
            assert!(ensure_allowed_host(&url).is_ok(), "{host} should be allowed");
        }

        // A host that merely ends with an allowed name is not that host.
        for bad in [
            "https://github.com.example.com/a.exe",
            "http://github.com/a.exe",
            "file:///C:/Windows/system32/cmd.exe",
        ] {
            let url = reqwest::Url::parse(bad).unwrap();
            assert!(ensure_allowed_host(&url).is_err(), "{bad} must be refused");
        }
    }

    #[test]
    fn check_digest_accepts_only_the_published_bytes() {
        let bytes = b"installer";
        let correct = Sha256::digest(bytes);
        let mut expected = [0u8; 32];
        expected.copy_from_slice(correct.as_slice());
        assert!(check_digest(bytes, expected).is_ok());

        expected[0] = expected[0].wrapping_add(1);
        assert!(check_digest(bytes, expected).is_err());
    }

    #[test]
    fn helper_script_holds_no_machine_paths_and_uses_crlf() {
        let script = installer_script();
        // Nothing from this machine is in the text, so nothing a folder name could
        // contain is ever re-parsed by cmd.
        let temp = std::env::temp_dir().to_string_lossy().to_string();
        assert!(!script.contains(&temp));
        assert!(script.contains("%~2"));
        assert!(script.contains("%~3"));
        assert!(script.contains("goto install"));
        assert!(script.contains("tasklist"));

        let without_pairs = script.replace("\r\n", "");
        assert!(!without_pairs.contains('\n'));
        let lines = INSTALLER_SCRIPT_LINES.len();
        assert_eq!(script.matches("\r\n").count(), lines);
    }

    #[test]
    fn staged_installer_keeps_the_release_name() {
        let path = installer_path("0.0.3");
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, "auto-quest-complete-discord-0.0.3-setup.exe");
        assert!(path.starts_with(std::env::temp_dir()));
    }

    #[test]
    fn the_platform_gate_matches_the_build_target() {
        if cfg!(windows) {
            assert!(ensure_supported_platform().is_ok());
        } else {
            let error = ensure_supported_platform().unwrap_err().to_string();
            assert!(error.contains("Windows"), "{error}");
        }
    }
}
