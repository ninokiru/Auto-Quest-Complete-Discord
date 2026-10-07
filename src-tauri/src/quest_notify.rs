//! Desktop notification for a finished quest.
//!
//! `tauri-plugin-notification` is deliberately not used here: it requires tauri
//! 2.12 and pulls in `notify-rust`, and the release workflow builds cargo with
//! `--locked`, so no dependency can be added without regenerating `Cargo.lock`
//! on a machine that has cargo. Windows goes straight to the shell notification
//! area, and the other platforms call their stock notifier.

use tauri::AppHandle;

pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    platform::show(app, title, body)
}

#[cfg(windows)]
mod platform {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tauri::{AppHandle, Manager};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::Shell::{
        NIF_ICON, NIF_INFO, NIIF_INFO, NIM_ADD, NIM_MODIFY, NOTIFYICONDATAW, Shell_NotifyIconW,
    };
    use windows::Win32::UI::WindowsAndMessaging::{IDI_APPLICATION, LoadIconW};

    const MAIN_WINDOW: &str = "main";
    /// Identifier for this process's notification-area entry. The entry is
    /// created on the first finished quest and kept for the rest of the process
    /// lifetime, because deleting it would take the balloon with it.
    const ENTRY_ID: u32 = 1;

    static ENTRY_ADDED: AtomicBool = AtomicBool::new(false);

    /// Write `value` into one of the fixed UTF-16 fields, truncating rather than
    /// overflowing. Quest names come from Discord and are not length-bounded.
    fn write_wide(value: &str, buffer: &mut [u16]) {
        let encoded: Vec<u16> = value.encode_utf16().take(buffer.len() - 1).collect();
        let copied = encoded.len();
        buffer[..copied].copy_from_slice(&encoded);
        buffer[copied] = 0;
    }

    pub fn show(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let window = app
            .get_webview_window(MAIN_WINDOW)
            .ok_or_else(|| "The main window is not available".to_string())?;
        let handle = window
            .hwnd()
            .map_err(|error| format!("Could not read the window handle: {error}"))?;
        let icon = unsafe { LoadIconW(None, IDI_APPLICATION) }
            .map_err(|error| format!("Could not load the application icon: {error}"))?;

        let mut entry = NOTIFYICONDATAW::default();
        entry.cbSize = core::mem::size_of::<NOTIFYICONDATAW>() as u32;
        // Tauri hands back the handle from its own `windows` version, so only the
        // raw pointer is portable between the two.
        let raw_handle: *mut core::ffi::c_void = handle.0;
        entry.hWnd = HWND(raw_handle);
        entry.uID = ENTRY_ID;
        entry.hIcon = icon;
        entry.dwInfoFlags = NIIF_INFO;
        write_wide(title, &mut entry.szInfoTitle);
        write_wide(body, &mut entry.szInfo);

        unsafe {
            if !ENTRY_ADDED.load(Ordering::SeqCst) {
                let mut registration = entry;
                registration.uFlags = NIF_ICON;
                if Shell_NotifyIconW(NIM_ADD, &registration).as_bool() {
                    ENTRY_ADDED.store(true, Ordering::SeqCst);
                }
            }
            entry.uFlags = NIF_INFO;
            if Shell_NotifyIconW(NIM_MODIFY, &entry).as_bool() {
                return Ok(());
            }
        }
        Err("The system refused the notification".to_string())
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::process::Command;
    use tauri::AppHandle;

    /// Escape for an AppleScript string literal. The arguments never pass through
    /// a shell, but the script text itself still needs quoting.
    fn literal(value: &str) -> String {
        let mut escaped = String::with_capacity(value.len() + 2);
        escaped.push('"');
        for character in value.chars() {
            match character {
                '"' | '\\' => {
                    escaped.push('\\');
                    escaped.push(character);
                }
                '\n' => escaped.push(' '),
                other => escaped.push(other),
            }
        }
        escaped.push('"');
        escaped
    }

    pub fn show(_app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let script = format!(
            "display notification {} with title {}",
            literal(body),
            literal(title)
        );
        let output = Command::new("/usr/bin/osascript")
            .args(["-e", &script])
            .output()
            .map_err(|error| format!("Could not run osascript: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        Err("osascript reported a failure".to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod platform {
    use std::process::Command;
    use tauri::AppHandle;

    pub fn show(_app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
        let status = Command::new("notify-send")
            .arg(title)
            .arg(body)
            .status()
            .map_err(|error| format!("Could not run notify-send: {error}"))?;
        if status.success() {
            return Ok(());
        }
        Err("notify-send reported a failure".to_string())
    }
}
