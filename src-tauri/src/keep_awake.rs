//! Holds off system sleep while at least one quest is running.
//!
//! A Windows execution request belongs to the thread that made it, so the
//! assertion and its release both run on one thread owned by this module.
//! `hold` and `release` are idempotent and the caller only reports whether any
//! quest is running, so a quest that finishes on its own cannot leave the
//! machine permanently awake the way a balanced acquire/release pair would.

use std::sync::mpsc;
use std::sync::Mutex;

/// Holding the sender open is what keeps the guard thread waiting; dropping it
/// closes the channel, which the thread reads as the signal to let go.
struct Guard {
    _thread: std::thread::JoinHandle<()>,
    _stop: mpsc::Sender<()>,
}

static GUARD: Mutex<Option<Guard>> = Mutex::new(None);

pub fn hold() {
    let mut slot = GUARD.lock().unwrap();
    if slot.is_some() {
        return;
    }

    let (stop, release) = mpsc::channel();
    let spawned = std::thread::Builder::new()
        .name("keep-awake".to_string())
        .spawn(move || {
            platform::assert_awake();
            let _ = release.recv();
            platform::clear_awake();
        });

    match spawned {
        Ok(thread) => {
            *slot = Some(Guard {
                _thread: thread,
                _stop: stop,
            })
        }
        Err(error) => eprintln!("Could not start the keep-awake guard: {error}"),
    }
}

pub fn release() {
    drop(GUARD.lock().unwrap().take());
}

#[cfg(windows)]
mod platform {
    use windows::Win32::System::Power;

    pub fn assert_awake() {
        // Only the system sleep timer is held off. Forcing the display to stay
        // on would drain a laptop overnight, and Discord keeps crediting play
        // time while the screen is blanked.
        let request = Power::ES_CONTINUOUS | Power::ES_SYSTEM_REQUIRED;
        unsafe {
            let _ = Power::SetThreadExecutionState(request);
        }
    }

    pub fn clear_awake() {
        unsafe {
            let _ = Power::SetThreadExecutionState(Power::ES_CONTINUOUS);
        }
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::{Command, Stdio};
    use std::sync::Mutex;

    static CAFFEINATE: Mutex<Option<std::process::Child>> = Mutex::new(None);

    pub fn assert_awake() {
        let mut child_slot = CAFFEINATE.lock().unwrap();
        if child_slot.is_some() {
            return;
        }
        // `-w <own pid>` ties caffeinate to this process, so it still exits if
        // the app is killed before clear_awake ever runs.
        let wait_flag = std::process::id().to_string();
        let started = Command::new("/usr/bin/caffeinate")
            .args(["-i", "-s", "-w", &wait_flag])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match started {
            Ok(child) => *child_slot = Some(child),
            Err(error) => {
                eprintln!("Could not start caffeinate to keep the machine awake: {error}");
            }
        }
    }

    pub fn clear_awake() {
        if let Some(mut child) = CAFFEINATE.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    pub fn assert_awake() {
        eprintln!(
            "Keeping the machine awake while quests run is not implemented on this platform; \
             the system sleep settings still apply."
        );
    }

    pub fn clear_awake() {}
}
