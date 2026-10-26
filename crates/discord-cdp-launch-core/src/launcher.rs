use crate::platform::SystemPlatform;
use crate::vesktop::{
    cdp_ready_matches_preference, find_vesktop_install, is_vesktop_running, spawn_vesktop,
    vesktop_launch_plan, VesktopInstall, VesktopLaunchPlan,
};
use crate::{
    CdpProbe, CdpProbeStatus, DiscordChannel, DiscordInstall, DiscordLaunchMode, LaunchError,
    LaunchOptions, LaunchOutcome, LaunchResult, ProviderId, SessionOwnership, StdCdpProbe,
    VariantId,
};
use std::ffi::OsString;
use std::time::{Duration, Instant};

/// How long `PortOccupied` may persist, observation after observation, before a
/// launch is abandoned. The probe reports every fetch failure other than "could
/// not connect" (connection reset, truncated response, HTTP 5xx) as
/// `PortOccupied`, and a Chromium that has only just opened its DevTools server
/// produces those for a moment. Failing on the first one would kill a client
/// that was seconds away from being ready.
const PORT_OCCUPIED_GRACE: Duration = Duration::from_secs(3);

/// Re-probe a port this call has just taken back, up to `occupied_grace`.
///
/// The exit wait only proves the process table no longer lists the client it
/// terminated; a DevTools server that is still closing answers the request with
/// a reset, and the probe reports that as `PortOccupied`. Reading one such reset
/// as a foreign owner would refuse a launch whose own client is already gone.
fn probe_after_shutdown<C: CdpProbe>(
    cdp: &C,
    options: &LaunchOptions,
    occupied_grace: Duration,
) -> CdpProbeStatus {
    let started = Instant::now();
    let mut status = cdp.probe(options.port);
    while matches!(status, CdpProbeStatus::PortOccupied) && started.elapsed() < occupied_grace {
        std::thread::sleep(options.poll_interval);
        status = cdp.probe(options.port);
    }
    status
}

fn readiness_timeout_for_observation(
    status: &CdpProbeStatus,
    saw_cdp_server: &mut bool,
    base_timeout: Duration,
    extended_timeout: Duration,
) -> Duration {
    if matches!(status, CdpProbeStatus::CdpWithoutDiscordTarget) {
        *saw_cdp_server = true;
    }
    if *saw_cdp_server {
        extended_timeout
    } else {
        base_timeout
    }
}

fn wait_for_cdp_readiness<C: CdpProbe>(
    cdp: &C,
    options: &LaunchOptions,
) -> Result<(), LaunchError> {
    wait_for_cdp_readiness_with_grace(cdp, options, PORT_OCCUPIED_GRACE)
}

fn wait_for_cdp_readiness_with_grace<C: CdpProbe>(
    cdp: &C,
    options: &LaunchOptions,
    occupied_grace: Duration,
) -> Result<(), LaunchError> {
    let started = Instant::now();
    let base_timeout = options.readiness_timeout;
    let extended_timeout = base_timeout.saturating_add(base_timeout);
    // Once a CDP server has appeared, keep the extended renderer grace period.
    // Discord's updater-to-app handoff can make the endpoint briefly disappear.
    let mut saw_cdp_server = false;
    // Start of the current unbroken run of `PortOccupied` observations.
    let mut occupied_since: Option<Instant> = None;
    let mut last = cdp.observe(options.port);
    let mut logged_status: Option<CdpProbeStatus> = None;

    loop {
        if logged_status.as_ref() != Some(&last.status) {
            eprintln!(
                "[cdp-launch] endpoint state={} targets={} elapsed={:.1}s",
                last.status.as_str(),
                last.target_count
                    .map(|count| count.to_string())
                    .unwrap_or_else(|| "unknown".to_string()),
                started.elapsed().as_secs_f64()
            );
            logged_status = Some(last.status.clone());
        }
        match &last.status {
            CdpProbeStatus::DiscordReady { .. } => return Ok(()),
            CdpProbeStatus::PortOccupied => {
                let since = *occupied_since.get_or_insert_with(Instant::now);
                if since.elapsed() >= occupied_grace {
                    return Err(LaunchError::PortOccupied { port: options.port });
                }
            }
            CdpProbeStatus::CdpWithoutDiscordTarget | CdpProbeStatus::Unreachable => {
                occupied_since = None;
            }
        }
        let timeout = readiness_timeout_for_observation(
            &last.status,
            &mut saw_cdp_server,
            base_timeout,
            extended_timeout,
        );
        if started.elapsed() >= timeout {
            if matches!(last.status, CdpProbeStatus::PortOccupied) {
                return Err(LaunchError::PortOccupied { port: options.port });
            }
            return Err(LaunchError::ReadinessTimeout {
                port: options.port,
                timeout,
                last_status: last.status,
                target_count: last.target_count,
                discord_target_count: last.discord_target_count,
                main_renderer_found: last.main_renderer_found,
            });
        }
        std::thread::sleep(options.poll_interval);
        last = cdp.observe(options.port);
    }
}

pub trait PlatformBackend {
    fn find_installs(&self) -> Result<Vec<DiscordInstall>, LaunchError>;
    fn is_running(&self, channel: Option<DiscordChannel>) -> Result<bool, LaunchError>;
    fn terminate(&self, channel: Option<DiscordChannel>) -> Result<(), LaunchError>;
    /// Launch the client and return its PID when the platform exposes it.
    /// Bundle launch services may only expose their own short-lived PID.
    fn spawn(
        &self,
        install: &DiscordInstall,
        mode: DiscordLaunchMode,
    ) -> Result<Option<u32>, LaunchError>;
}

pub fn find_discord_installs() -> Result<Vec<DiscordInstall>, LaunchError> {
    SystemPlatform.find_installs()
}

pub fn select_preferred_install(
    installs: &[DiscordInstall],
    channel: Option<DiscordChannel>,
) -> Result<DiscordInstall, LaunchError> {
    let selected = if let Some(channel) = channel {
        installs.iter().find(|install| install.channel == channel)
    } else {
        DiscordChannel::ALL
            .iter()
            .find_map(|channel| installs.iter().find(|install| install.channel == *channel))
    };

    selected
        .cloned()
        .ok_or(LaunchError::InstallNotFound { channel })
}

pub fn is_cdp_available(port: u16) -> bool {
    matches!(
        StdCdpProbe::default().probe(port),
        CdpProbeStatus::DiscordReady { .. }
    )
}

pub fn is_discord_running(channel: Option<DiscordChannel>) -> Result<bool, LaunchError> {
    SystemPlatform.is_running(channel)
}

pub fn terminate_discord_processes(channel: Option<DiscordChannel>) -> Result<(), LaunchError> {
    SystemPlatform.terminate(channel)
}

pub fn launch_discord_with_cdp(options: LaunchOptions) -> Result<LaunchResult, LaunchError> {
    if is_cdp_available(options.port) {
        let owner = crate::inspect_cdp_port_owner(options.port);
        if !cdp_ready_matches_preference(options.client, owner) {
            return Err(LaunchError::CdpOwnedByOtherClient {
                port: options.port,
                owner: owner.as_str(),
            });
        }
        if options.installation.as_ref().is_some_and(|installation| {
            !crate::processes::cdp_port_matches_installation(options.port, installation)
        }) {
            return Err(LaunchError::CdpOwnedByOtherClient {
                port: options.port,
                owner: "another installation",
            });
        }
    }
    if should_launch_vesktop(&options)? {
        let selected_installation = options
            .installation
            .clone()
            .or_else(discovered_vesktop_installation);
        if let Some(installation) = selected_installation.as_ref().filter(|installation| {
            matches!(
                &installation.launch_target,
                crate::LaunchTarget::Flatpak { .. }
            )
        }) {
            return launch_flatpak_with_cdp(options, installation, &StdCdpProbe::default());
        }
        let install = selected_installation
            .as_ref()
            .and_then(crate::installation_as_vesktop)
            .or_else(find_vesktop_install)
            .ok_or(LaunchError::InstallNotFound { channel: None })?;
        return launch_vesktop_with_cdp(
            options,
            install,
            selected_installation.as_ref(),
            &StdCdpProbe::default(),
        );
    }
    launch_with_backends(options, &SystemPlatform, &StdCdpProbe::default())
}

fn launch_flatpak_with_cdp<C: CdpProbe>(
    options: LaunchOptions,
    installation: &crate::ClientInstallation,
    cdp: &C,
) -> Result<LaunchResult, LaunchError> {
    let crate::LaunchTarget::Flatpak { app_id, command } = &installation.launch_target else {
        return Err(LaunchError::InvalidInstallation {
            details: "The selected target is not a Flatpak application.".into(),
        });
    };
    validated_flatpak_command(command.as_deref())?;
    validated_flatpak_app_id(app_id)?;
    if options.port == 0 {
        return Err(LaunchError::InvalidPort(options.port));
    }
    match cdp.probe(options.port) {
        CdpProbeStatus::DiscordReady { .. } => {
            if !options.restart_existing {
                return Ok(flatpak_result(
                    installation,
                    &options,
                    LaunchOutcome::AlreadyAvailable,
                    None,
                    true,
                ));
            }
        }
        CdpProbeStatus::PortOccupied => {
            return Err(LaunchError::PortOccupied { port: options.port })
        }
        CdpProbeStatus::Unreachable | CdpProbeStatus::CdpWithoutDiscordTarget => {}
    }
    let mut terminated_existing = false;
    if flatpak_is_running(app_id, command.as_deref())? {
        if !options.restart_existing {
            return Err(LaunchError::DesktopClientAlreadyRunning { client: "Vesktop" });
        }
        flatpak_kill(app_id, command.as_deref())?;
        wait_until_flatpak_exits(app_id, command.as_deref(), &options)?;
        terminated_existing = true;
    }
    match probe_after_shutdown(cdp, &options, PORT_OCCUPIED_GRACE) {
        CdpProbeStatus::Unreachable => {}
        CdpProbeStatus::DiscordReady { .. } => {
            return Ok(flatpak_result(
                installation,
                &options,
                LaunchOutcome::AlreadyAvailable,
                None,
                true,
            ));
        }
        CdpProbeStatus::PortOccupied => {
            if terminated_existing {
                abandon_failed_flatpak_launch(app_id, command.as_deref(), &options);
            }
            return Err(LaunchError::PortOccupied { port: options.port });
        }
        CdpProbeStatus::CdpWithoutDiscordTarget => {
            if terminated_existing {
                abandon_failed_flatpak_launch(app_id, command.as_deref(), &options);
            }
            return Err(LaunchError::NonDiscordCdpTarget { port: options.port });
        }
    }
    let pid = flatpak_spawn(app_id, command.as_deref(), Some(options.port))?;
    eprintln!("[cdp-launch] process spawned pid={pid}");
    if !options.wait_for_cdp {
        return Ok(flatpak_result(
            installation,
            &options,
            LaunchOutcome::Spawned,
            Some(pid),
            false,
        ));
    }
    if let Err(error) = wait_for_cdp_readiness(cdp, &options) {
        // Same rule as the other targets: an unjournaled Flatpak client must not
        // survive this call with its debugging port open.
        abandon_failed_flatpak_launch(app_id, command.as_deref(), &options);
        return Err(error);
    }
    Ok(flatpak_result(
        installation,
        &options,
        LaunchOutcome::Spawned,
        Some(pid),
        true,
    ))
}

/// Poll `flatpak ps` until the application is gone or `shutdown_timeout` runs
/// out.
fn wait_until_flatpak_exits(
    app_id: &str,
    command: Option<&str>,
    options: &LaunchOptions,
) -> Result<(), LaunchError> {
    let started = Instant::now();
    loop {
        if !flatpak_is_running(app_id, command)? {
            return Ok(());
        }
        if started.elapsed() >= options.shutdown_timeout {
            return Err(LaunchError::ShutdownTimeout {
                timeout: options.shutdown_timeout,
            });
        }
        std::thread::sleep(options.poll_interval);
    }
}

/// Flatpak counterpart of [`abandon_failed_cdp_launch`]: close the client that
/// was started with a debug port, wait until it is really gone, and only then
/// start it again in normal mode. Relaunching while the old instance is still
/// shutting down lets Electron's single-instance lock hand the new process over
/// to the dying one, which leaves the user with no Discord at all.
fn abandon_failed_flatpak_launch(app_id: &str, command: Option<&str>, options: &LaunchOptions) {
    // An unreadable process list is treated as "still running": leaving a debug
    // port open is the worse of the two mistakes.
    if flatpak_is_running(app_id, command).unwrap_or(true) {
        if flatpak_kill(app_id, command).is_ok() {
            let _ = wait_until_flatpak_exits(app_id, command, options);
        }
        if flatpak_is_running(app_id, command).unwrap_or(true) {
            eprintln!("[cdp-launch] could not stop {app_id}; its debugging port may still be open");
            return;
        }
    }
    let _ = flatpak_spawn(app_id, command, None);
}

fn flatpak_result(
    installation: &crate::ClientInstallation,
    options: &LaunchOptions,
    outcome: LaunchOutcome,
    pid: Option<u32>,
    cdp_connected: bool,
) -> LaunchResult {
    LaunchResult {
        outcome,
        launched_path: std::path::PathBuf::new(),
        // A Flatpak client has no official release channel, so the channel the
        // caller selected is the closest honest answer.
        channel: options.channel.unwrap_or(DiscordChannel::Stable),
        port: options.port,
        pid,
        cdp_connected,
        provider_id: ProviderId::vesktop(),
        installation_id: Some(installation.id.clone()),
        variant_id: installation.variant_id.clone(),
        ownership: if outcome == LaunchOutcome::Spawned {
            SessionOwnership::Managed
        } else {
            SessionOwnership::ExternalAttached
        },
    }
}

#[cfg(target_os = "linux")]
pub(crate) fn flatpak_is_running(app_id: &str, command: Option<&str>) -> Result<bool, LaunchError> {
    let command = validated_flatpak_command(command)?;
    let output = std::process::Command::new(command)
        .args(["ps", "--columns=application"])
        .output()
        .map_err(|source| LaunchError::ProcessInspection {
            operation: "flatpak ps",
            source,
        })?;
    Ok(output.status.success()
        && String::from_utf8_lossy(&output.stdout)
            .lines()
            .any(|line| line.trim() == app_id))
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn flatpak_is_running(
    _app_id: &str,
    _command: Option<&str>,
) -> Result<bool, LaunchError> {
    Err(LaunchError::UnsupportedPlatform)
}

#[cfg(target_os = "linux")]
pub(crate) fn flatpak_kill(app_id: &str, command: Option<&str>) -> Result<(), LaunchError> {
    let command = validated_flatpak_command(command)?;
    let app_id = validated_flatpak_app_id(app_id)?;
    let output = std::process::Command::new(command)
        .args(["kill", app_id])
        .output()
        .map_err(|source| LaunchError::ProcessInspection {
            operation: "flatpak kill",
            source,
        })?;
    if output.status.success() {
        Ok(())
    } else {
        Err(LaunchError::ProcessTermination {
            process: app_id.into(),
            details: String::from_utf8_lossy(&output.stderr).trim().into(),
        })
    }
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn flatpak_kill(_app_id: &str, _command: Option<&str>) -> Result<(), LaunchError> {
    Err(LaunchError::UnsupportedPlatform)
}

#[cfg(target_os = "linux")]
pub(crate) fn flatpak_spawn(
    app_id: &str,
    command: Option<&str>,
    port: Option<u16>,
) -> Result<u32, LaunchError> {
    let command = validated_flatpak_command(command)?;
    let app_id = validated_flatpak_app_id(app_id)?;
    let mut process = std::process::Command::new(command);
    process.args(["run", app_id]);
    if let Some(port) = port {
        process.arg(format!("--remote-debugging-port={port}"));
    }
    process
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(reap_spawned_child)
        .map_err(|source| LaunchError::SpawnFailed {
            path: std::path::PathBuf::from(command),
            source,
        })
}

#[cfg(not(target_os = "linux"))]
pub(crate) fn flatpak_spawn(
    _app_id: &str,
    _command: Option<&str>,
    _port: Option<u16>,
) -> Result<u32, LaunchError> {
    Err(LaunchError::UnsupportedPlatform)
}

fn should_launch_vesktop(options: &LaunchOptions) -> Result<bool, LaunchError> {
    if let Some(installation) = &options.installation {
        return Ok(installation.provider_id == ProviderId::vesktop());
    }
    let official_running = SystemPlatform.is_running(options.channel)?;
    let vesktop_running = is_vesktop_running()?;
    let official_install_found =
        select_preferred_install(&SystemPlatform.find_installs()?, options.channel).is_ok();
    let vesktop_install_found = discovered_vesktop_installation().is_some();
    Ok(vesktop_launch_plan(
        options.channel,
        options.client,
        official_running,
        vesktop_running,
        official_install_found,
        vesktop_install_found,
    ) == VesktopLaunchPlan::LaunchVesktop)
}

fn discovered_vesktop_installation() -> Option<crate::ClientInstallation> {
    crate::discover_client_installations()
        .0
        .into_iter()
        .find(|installation| {
            installation.provider_id == ProviderId::vesktop()
                && installation.validation == crate::ValidationState::Valid
        })
}

fn validated_flatpak_command(command: Option<&str>) -> Result<&str, LaunchError> {
    let command = command.unwrap_or("flatpak");
    if command == "flatpak" {
        Ok(command)
    } else {
        Err(LaunchError::InvalidInstallation {
            details: "Flatpak launch targets must use the flatpak command.".into(),
        })
    }
}

/// The application id is passed to `flatpak` as an argument, so a value that
/// starts with `-` would be read as an option. Require the reverse-DNS shape
/// Flatpak itself uses: at least two dot-separated, non-empty segments made of
/// letters, digits, `_` and `-`.
fn validated_flatpak_app_id(app_id: &str) -> Result<&str, LaunchError> {
    let valid = !app_id.starts_with('-')
        && app_id.len() <= 255
        && app_id.split('.').count() >= 2
        && app_id.split('.').all(|segment| {
            !segment.is_empty()
                && segment
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
        });
    if valid {
        Ok(app_id)
    } else {
        Err(LaunchError::InvalidInstallation {
            details: "The Flatpak application id is not a valid reverse-DNS name.".into(),
        })
    }
}

#[cfg(target_os = "linux")]
fn reap_spawned_child(mut child: std::process::Child) -> u32 {
    let pid = child.id();
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    pid
}

fn launch_vesktop_with_cdp<C: CdpProbe>(
    options: LaunchOptions,
    install: VesktopInstall,
    selected_installation: Option<&crate::ClientInstallation>,
    cdp: &C,
) -> Result<LaunchResult, LaunchError> {
    if options.port == 0 {
        return Err(LaunchError::InvalidPort(options.port));
    }

    match cdp.probe(options.port) {
        CdpProbeStatus::DiscordReady { .. } => {
            if !options.restart_existing {
                return Ok(vesktop_result(
                    &install,
                    &options,
                    selected_installation,
                    LaunchOutcome::AlreadyAvailable,
                    None,
                    true,
                ));
            }
        }
        CdpProbeStatus::PortOccupied => {
            return Err(LaunchError::PortOccupied { port: options.port });
        }
        CdpProbeStatus::Unreachable | CdpProbeStatus::CdpWithoutDiscordTarget => {}
    }

    let supervised_installation = selected_installation.cloned().unwrap_or_else(|| {
        crate::provider::vesktop_installation(install.clone(), crate::DiscoverySource::StandardPath)
    });
    let running = crate::ProcessSupervisor::installation_running(&supervised_installation);
    if running && !options.restart_existing {
        return Err(LaunchError::DesktopClientAlreadyRunning { client: "Vesktop" });
    }
    let mut terminated_existing = false;
    if running {
        crate::ProcessSupervisor::terminate_exact(&supervised_installation)?;
        crate::ProcessSupervisor::wait_for_exit(
            &supervised_installation,
            options.shutdown_timeout,
            options.poll_interval,
        )?;
        terminated_existing = true;
    }

    match probe_after_shutdown(cdp, &options, PORT_OCCUPIED_GRACE) {
        CdpProbeStatus::Unreachable => {}
        CdpProbeStatus::DiscordReady { .. } => {
            return Ok(vesktop_result(
                &install,
                &options,
                selected_installation,
                LaunchOutcome::AlreadyAvailable,
                None,
                true,
            ));
        }
        CdpProbeStatus::PortOccupied => {
            if terminated_existing {
                abandon_failed_vesktop_launch(&install, &supervised_installation, &options);
            }
            return Err(LaunchError::PortOccupied { port: options.port });
        }
        CdpProbeStatus::CdpWithoutDiscordTarget => {
            if terminated_existing {
                abandon_failed_vesktop_launch(&install, &supervised_installation, &options);
            }
            return Err(LaunchError::NonDiscordCdpTarget { port: options.port });
        }
    }

    let pid = spawn_vesktop(&install, DiscordLaunchMode::Cdp { port: options.port })?;
    eprintln!("[cdp-launch] process spawned pid={pid}");
    if !options.wait_for_cdp {
        return Ok(vesktop_result(
            &install,
            &options,
            selected_installation,
            LaunchOutcome::Spawned,
            Some(pid),
            false,
        ));
    }

    if let Err(error) = wait_for_cdp_readiness(cdp, &options) {
        abandon_failed_vesktop_launch(&install, &supervised_installation, &options);
        return Err(error);
    }
    Ok(vesktop_result(
        &install,
        &options,
        selected_installation,
        LaunchOutcome::Spawned,
        Some(pid),
        true,
    ))
}

/// Vesktop counterpart of [`abandon_failed_cdp_launch`]. The instance has no
/// `LaunchResult` to carry its pid, so this is the only chance to close the
/// debug port it left open, and the relaunch happens only once it is really
/// gone: Electron's single-instance lock otherwise hands the new process over to
/// the dying one and leaves the user with neither.
fn abandon_failed_vesktop_launch(
    install: &VesktopInstall,
    supervised_installation: &crate::ClientInstallation,
    options: &LaunchOptions,
) {
    let _ = crate::terminate_installation_process_tree(&install.executable_path);
    if crate::ProcessSupervisor::wait_for_exit(
        supervised_installation,
        options.shutdown_timeout,
        options.poll_interval,
    )
    .is_ok()
    {
        let _ = spawn_vesktop(install, DiscordLaunchMode::Normal);
    } else {
        eprintln!("[cdp-launch] could not stop Vesktop; its debugging port may still be open");
    }
}

fn vesktop_result(
    install: &VesktopInstall,
    options: &LaunchOptions,
    selected_installation: Option<&crate::ClientInstallation>,
    outcome: LaunchOutcome,
    pid: Option<u32>,
    cdp_connected: bool,
) -> LaunchResult {
    let installation = selected_installation.cloned().unwrap_or_else(|| {
        crate::provider::vesktop_installation(install.clone(), crate::DiscoverySource::StandardPath)
    });
    LaunchResult {
        outcome,
        launched_path: install.executable_path.clone(),
        // Vesktop ships one build with no official release channel, so the
        // channel the caller selected is the closest honest answer.
        channel: options.channel.unwrap_or(DiscordChannel::Stable),
        port: options.port,
        pid,
        cdp_connected,
        provider_id: ProviderId::vesktop(),
        installation_id: Some(installation.id),
        variant_id: None,
        ownership: if outcome == LaunchOutcome::Spawned {
            SessionOwnership::Managed
        } else {
            SessionOwnership::ExternalAttached
        },
    }
}

pub fn restart_discord_with_cdp(mut options: LaunchOptions) -> Result<LaunchResult, LaunchError> {
    options.restart_existing = true;
    launch_discord_with_cdp(options)
}

#[doc(hidden)]
pub fn launch_with_backends<P, C>(
    options: LaunchOptions,
    platform: &P,
    cdp: &C,
) -> Result<LaunchResult, LaunchError>
where
    P: PlatformBackend,
    C: CdpProbe,
{
    if options.port == 0 {
        return Err(LaunchError::InvalidPort(options.port));
    }

    match cdp.probe(options.port) {
        CdpProbeStatus::DiscordReady { .. } => {
            if !options.restart_existing {
                return already_available_result(
                    &options,
                    platform.find_installs()?,
                    Some(crate::inspect_cdp_port_owner(options.port)),
                );
            }
        }
        CdpProbeStatus::PortOccupied => {
            return Err(LaunchError::PortOccupied { port: options.port });
        }
        CdpProbeStatus::Unreachable | CdpProbeStatus::CdpWithoutDiscordTarget => {}
    }

    let installs = platform.find_installs()?;
    let install = if let Some(selected) = &options.installation {
        crate::installation_as_official(selected).ok_or_else(|| {
            LaunchError::InvalidInstallation {
                details: "The selected installation is not a valid official Discord target.".into(),
            }
        })?
    } else {
        select_preferred_install(&installs, options.channel)?
    };
    let selected_channel = Some(install.channel);
    let running = platform.is_running(selected_channel)?;
    if running && !options.restart_existing {
        return Err(LaunchError::DiscordAlreadyRunning {
            channel: selected_channel,
        });
    }
    let mut terminated_existing = false;
    if running {
        platform.terminate(selected_channel)?;
        wait_until_discord_exits(platform, selected_channel, &options)?;
        terminated_existing = true;
    }

    match probe_after_shutdown(cdp, &options, PORT_OCCUPIED_GRACE) {
        CdpProbeStatus::Unreachable => {}
        CdpProbeStatus::DiscordReady { .. } => {
            return already_available_result(
                &options,
                platform.find_installs()?,
                Some(crate::inspect_cdp_port_owner(options.port)),
            );
        }
        CdpProbeStatus::PortOccupied => {
            if terminated_existing {
                abandon_failed_cdp_launch(platform, &install, selected_channel, &options);
            }
            return Err(LaunchError::PortOccupied { port: options.port });
        }
        CdpProbeStatus::CdpWithoutDiscordTarget => {
            if terminated_existing {
                abandon_failed_cdp_launch(platform, &install, selected_channel, &options);
            }
            return Err(LaunchError::NonDiscordCdpTarget { port: options.port });
        }
    }

    let pid = platform.spawn(&install, DiscordLaunchMode::Cdp { port: options.port })?;
    eprintln!("[cdp-launch] process spawned pid={pid:?}");
    if !options.wait_for_cdp {
        return Ok(result_for(
            &install,
            &options,
            LaunchOutcome::Spawned,
            pid,
            false,
        ));
    }

    if let Err(error) = wait_for_cdp_readiness(cdp, &options) {
        abandon_failed_cdp_launch(platform, &install, selected_channel, &options);
        return Err(error);
    }
    Ok(result_for(
        &install,
        &options,
        LaunchOutcome::Spawned,
        pid,
        true,
    ))
}

#[allow(dead_code)]
fn _assert_backend_object_safe(_backend: &dyn PlatformBackend) {}

fn already_available_result(
    options: &LaunchOptions,
    installs: Vec<DiscordInstall>,
    owner: Option<crate::CdpPortOwner>,
) -> Result<LaunchResult, LaunchError> {
    let provider_id = match owner.unwrap_or(crate::CdpPortOwner::None) {
        crate::CdpPortOwner::Vesktop => ProviderId::vesktop(),
        crate::CdpPortOwner::Official => ProviderId::official_discord(),
        crate::CdpPortOwner::None | crate::CdpPortOwner::Other => match options.client {
            crate::DesktopClientPreference::Vesktop => ProviderId::vesktop(),
            _ => ProviderId::official_discord(),
        },
    };
    if provider_id == ProviderId::official_discord() {
        // When the caller picked a specific installation, describe that one;
        // the preferred install may be a different channel, and mixing its path
        // and channel with the selected installation's id would be misleading.
        let install = match &options.installation {
            Some(selected) => crate::installation_as_official(selected),
            None => select_preferred_install(&installs, options.channel).ok(),
        };
        if let Some(install) = install {
            return Ok(result_for(
                &install,
                options,
                LaunchOutcome::AlreadyAvailable,
                None,
                true,
            ));
        }
    }

    // CDP is authoritative: a working Discord CDP target may come from a
    // portable, Flatpak, or otherwise undiscoverable install. Do not reject an
    // already-usable session merely because no local executable path is known.
    Ok(LaunchResult {
        outcome: LaunchOutcome::AlreadyAvailable,
        launched_path: std::path::PathBuf::new(),
        channel: options.channel.unwrap_or(DiscordChannel::Stable),
        port: options.port,
        pid: None,
        cdp_connected: true,
        provider_id,
        installation_id: options
            .installation
            .as_ref()
            .map(|install| install.id.clone()),
        variant_id: options
            .installation
            .as_ref()
            .and_then(|install| install.variant_id.clone()),
        ownership: SessionOwnership::ExternalAttached,
    })
}

pub fn build_launch_args(mode: DiscordLaunchMode) -> Vec<OsString> {
    match mode {
        DiscordLaunchMode::Normal => Vec::new(),
        DiscordLaunchMode::Cdp { port } => {
            vec![OsString::from(format!("--remote-debugging-port={port}"))]
        }
    }
}

fn wait_until_discord_exits<P: PlatformBackend>(
    platform: &P,
    channel: Option<DiscordChannel>,
    options: &LaunchOptions,
) -> Result<(), LaunchError> {
    let started = Instant::now();
    while started.elapsed() < options.shutdown_timeout {
        if !platform.is_running(channel)? {
            return Ok(());
        }
        std::thread::sleep(options.poll_interval);
    }
    Err(LaunchError::ShutdownTimeout {
        timeout: options.shutdown_timeout,
    })
}

/// Clean up after a CDP spawn whose endpoint never became Discord-ready.
///
/// The readiness error is returned without a `LaunchResult`, so the process this
/// call started is never journalled: no session list shows it, nothing reaps it,
/// and it keeps listening on `--remote-debugging-port` with the user's logged-in
/// Discord behind that port. Only this call's client can be on the channel here
/// (a pre-existing one was terminated before the spawn), so terminating the
/// channel closes the window, and the normal-mode relaunch keeps the user from
/// losing their Discord because a debug endpoint was slow.
///
/// The relaunch only happens once the old client is confirmed gone. If it cannot
/// be stopped it is left alone: starting a second instance next to it would not
/// restore anything and would not close the debug port either.
fn abandon_failed_cdp_launch<P: PlatformBackend>(
    platform: &P,
    install: &DiscordInstall,
    channel: Option<DiscordChannel>,
    options: &LaunchOptions,
) {
    // An unreadable process table is treated as "still running": leaving a debug
    // port open is the worse of the two mistakes.
    if platform.is_running(channel).unwrap_or(true) {
        if platform.terminate(channel).is_ok() {
            let _ = wait_until_discord_exits(platform, channel, options);
        }
        if platform.is_running(channel).unwrap_or(true) {
            eprintln!("[cdp-launch] could not stop Discord; its debugging port may still be open");
            return;
        }
    }
    let _ = platform.spawn(install, DiscordLaunchMode::Normal);
}

fn result_for(
    install: &DiscordInstall,
    options: &LaunchOptions,
    outcome: LaunchOutcome,
    pid: Option<u32>,
    cdp_connected: bool,
) -> LaunchResult {
    let installation = options
        .installation
        .clone()
        .unwrap_or_else(|| crate::provider::official_installation(install.clone()));
    LaunchResult {
        outcome,
        launched_path: install.executable_path.clone(),
        channel: install.channel,
        port: options.port,
        pid,
        cdp_connected,
        provider_id: ProviderId::official_discord(),
        installation_id: Some(installation.id),
        variant_id: installation
            .variant_id
            .or_else(|| Some(VariantId(install.channel.as_str().to_string()))),
        ownership: if outcome == LaunchOutcome::Spawned {
            SessionOwnership::Managed
        } else {
            SessionOwnership::ExternalAttached
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Probe that replays a fixed sequence of statuses, then repeats `fallback`.
    struct SequenceProbe {
        sequence: Mutex<VecDeque<CdpProbeStatus>>,
        fallback: CdpProbeStatus,
    }

    impl SequenceProbe {
        fn new(sequence: Vec<CdpProbeStatus>, fallback: CdpProbeStatus) -> Self {
            Self {
                sequence: Mutex::new(sequence.into()),
                fallback,
            }
        }
    }

    impl CdpProbe for SequenceProbe {
        fn probe(&self, _port: u16) -> CdpProbeStatus {
            self.sequence
                .lock()
                .unwrap()
                .pop_front()
                .unwrap_or_else(|| self.fallback.clone())
        }
    }

    fn ready() -> CdpProbeStatus {
        CdpProbeStatus::DiscordReady { target_title: None }
    }

    fn fast_options(readiness_timeout: Duration) -> LaunchOptions {
        LaunchOptions {
            port: 9223,
            readiness_timeout,
            poll_interval: Duration::from_millis(2),
            ..Default::default()
        }
    }

    #[test]
    fn rejects_custom_flatpak_commands() {
        assert!(validated_flatpak_command(Some("flatpak")).is_ok());
        assert!(validated_flatpak_command(None).is_ok());
        assert!(matches!(
            validated_flatpak_command(Some("/tmp/launcher")),
            Err(LaunchError::InvalidInstallation { .. })
        ));
    }

    #[test]
    fn flatpak_app_ids_must_be_reverse_dns_names() {
        for valid in ["dev.vencord.Vesktop", "org.example.App-1", "a.b"] {
            assert!(validated_flatpak_app_id(valid).is_ok(), "{valid}");
        }
        for invalid in [
            "",
            "-rf",
            "--socket=x.y",
            "nodots",
            "a..b",
            ".a.b",
            "a.b.",
            "a b.c",
            "a.b/c",
        ] {
            assert!(
                matches!(
                    validated_flatpak_app_id(invalid),
                    Err(LaunchError::InvalidInstallation { .. })
                ),
                "{invalid}"
            );
        }
    }

    #[test]
    fn already_available_result_reports_the_observed_vesktop_owner() {
        let options = LaunchOptions {
            port: 9223,
            ..Default::default()
        };
        let result =
            already_available_result(&options, Vec::new(), Some(crate::CdpPortOwner::Vesktop))
                .expect("a ready CDP endpoint should be attachable");
        assert_eq!(result.provider_id, ProviderId::vesktop());
        assert_eq!(result.ownership, SessionOwnership::ExternalAttached);
    }

    #[test]
    fn renderer_grace_remains_enabled_during_endpoint_handoff() {
        let base = Duration::from_secs(15);
        let extended = Duration::from_secs(30);
        let mut saw_cdp_server = false;

        assert_eq!(
            readiness_timeout_for_observation(
                &CdpProbeStatus::CdpWithoutDiscordTarget,
                &mut saw_cdp_server,
                base,
                extended,
            ),
            extended
        );
        assert_eq!(
            readiness_timeout_for_observation(
                &CdpProbeStatus::Unreachable,
                &mut saw_cdp_server,
                base,
                extended,
            ),
            extended
        );
    }

    #[test]
    fn a_brief_port_occupied_blip_does_not_abort_readiness() {
        let cdp = SequenceProbe::new(
            vec![
                CdpProbeStatus::PortOccupied,
                CdpProbeStatus::PortOccupied,
                CdpProbeStatus::CdpWithoutDiscordTarget,
            ],
            ready(),
        );
        let result = wait_for_cdp_readiness_with_grace(
            &cdp,
            &fast_options(Duration::from_secs(5)),
            Duration::from_secs(1),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn a_persistent_port_occupied_fails_once_the_grace_expires() {
        let cdp = SequenceProbe::new(Vec::new(), CdpProbeStatus::PortOccupied);
        let result = wait_for_cdp_readiness_with_grace(
            &cdp,
            &fast_options(Duration::from_secs(5)),
            Duration::from_millis(30),
        );
        assert!(matches!(
            result,
            Err(LaunchError::PortOccupied { port: 9223 })
        ));
    }

    #[test]
    fn readiness_times_out_when_the_endpoint_never_appears() {
        let cdp = SequenceProbe::new(Vec::new(), CdpProbeStatus::Unreachable);
        let result = wait_for_cdp_readiness_with_grace(
            &cdp,
            &fast_options(Duration::from_millis(30)),
            Duration::from_secs(1),
        );
        assert!(matches!(result, Err(LaunchError::ReadinessTimeout { .. })));
    }

    #[test]
    fn a_reset_from_the_client_being_replaced_does_not_claim_the_port() {
        let cdp = SequenceProbe::new(
            vec![
                CdpProbeStatus::PortOccupied,
                CdpProbeStatus::PortOccupied,
                CdpProbeStatus::Unreachable,
            ],
            CdpProbeStatus::PortOccupied,
        );
        let options = fast_options(Duration::from_secs(5));
        assert_eq!(
            probe_after_shutdown(&cdp, &options, Duration::from_secs(1)),
            CdpProbeStatus::Unreachable
        );
    }

    #[test]
    fn a_port_that_keeps_refusing_stays_occupied() {
        let cdp = SequenceProbe::new(Vec::new(), CdpProbeStatus::PortOccupied);
        let options = fast_options(Duration::from_secs(5));
        assert_eq!(
            probe_after_shutdown(&cdp, &options, Duration::from_millis(30)),
            CdpProbeStatus::PortOccupied
        );
    }
}
