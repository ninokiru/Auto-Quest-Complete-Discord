use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Emitter, Manager, Runtime};

const HISTORY_VERSION: u32 = 1;
const HISTORY_FILE: &str = "game-simulation-history.v1.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameSimulationHistoryEntry {
    pub app_id: String,
    pub app_name: String,
    pub total_seconds: u64,
    pub updated_at: String,
}

/// One simulated application currently being recorded.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimulationHistorySegment {
    pub app_id: String,
    pub app_name: String,
    pub pending_finish: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SimulationHistoryStatus {
    pub active: bool,
    pub pending_finish: bool,
    pub app_id: Option<String>,
    pub app_name: Option<String>,
    /// Every concurrently recorded application. The singular fields above
    /// mirror `segments.first()` so older callers keep a stable shape.
    pub segments: Vec<SimulationHistorySegment>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct PersistedHistory {
    #[serde(default = "history_version")]
    version: u32,
    #[serde(default)]
    accounts: HashMap<String, HashMap<String, GameSimulationHistoryEntry>>,
}

fn history_version() -> u32 {
    HISTORY_VERSION
}

#[derive(Debug)]
struct ActiveUsage {
    id: u64,
    user_id: String,
    app_id: String,
    app_name: String,
    path: PathBuf,
    checkpoint_at: Instant,
    /// Frozen elapsed interval after native activity has stopped. A failed
    /// final save can then be retried without counting the retry delay.
    pending_finish_seconds: Option<u64>,
}

/// A segment whose interval was frozen for a final, single-save finish.
struct SegmentRecord {
    user_id: String,
    app_id: String,
    app_name: String,
    seconds: u64,
}

#[derive(Debug, Default)]
struct HistoryRuntime {
    loaded: bool,
    next_usage_id: u64,
    data: PersistedHistory,
    active: Vec<ActiveUsage>,
}

#[derive(Debug, Default)]
pub struct SimulationHistory {
    runtime: tokio::sync::Mutex<HistoryRuntime>,
}

impl SimulationHistory {
    pub fn file_path<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
        let directory = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("Failed to resolve app data directory: {error}"))?;
        Ok(directory.join(HISTORY_FILE))
    }

    async fn ensure_loaded(&self, path: &Path) -> Result<(), String> {
        let mut runtime = self.runtime.lock().await;
        if runtime.loaded {
            return Ok(());
        }
        if !path.exists() {
            runtime.data = PersistedHistory {
                version: HISTORY_VERSION,
                ..PersistedHistory::default()
            };
            runtime.loaded = true;
            return Ok(());
        }
        let bytes = std::fs::read(path)
            .map_err(|error| format!("Failed to read game simulation history: {error}"))?;
        runtime.data = match serde_json::from_slice::<PersistedHistory>(&bytes) {
            Ok(data) => data,
            Err(error) => {
                // A truncated or externally modified file must not brick usage
                // tracking. Without this recovery the parse error would repeat
                // on every `ensure_loaded`, so `begin` would fail forever and
                // (now that history is mandatory) block every simulation until
                // the file was deleted by hand. Preserve the unreadable bytes
                // for diagnosis and start from an empty history.
                let quarantine =
                    path.with_extension(format!("json.corrupt-{}", uuid::Uuid::new_v4()));
                std::fs::rename(path, &quarantine).map_err(|rename_error| {
                    format!(
                        "Game simulation history at {} is unreadable ({error}) and could not be preserved at {}: {rename_error}",
                        path.display(),
                        quarantine.display()
                    )
                })?;
                eprintln!(
                    "Game simulation history at {} is unreadable ({error}); moved it to {} and starting with an empty history",
                    path.display(),
                    quarantine.display()
                );
                PersistedHistory::default()
            }
        };
        runtime.data.version = HISTORY_VERSION;
        runtime.loaded = true;
        Ok(())
    }

    fn save_locked(runtime: &HistoryRuntime, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("Failed to create history directory: {error}"))?;
        }
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&runtime.data)
            .map_err(|error| format!("Failed to serialize game simulation history: {error}"))?;
        {
            let mut file = std::fs::File::create(&temporary)
                .map_err(|error| format!("Failed to write game simulation history: {error}"))?;
            file.write_all(&bytes)
                .and_then(|_| file.sync_all())
                .map_err(|error| format!("Failed to flush game simulation history: {error}"))?;
        }
        replace_file(&temporary, path)
    }

    fn add_elapsed(
        runtime: &mut HistoryRuntime,
        user_id: &str,
        app_id: &str,
        app_name: &str,
        seconds: u64,
    ) -> Option<GameSimulationHistoryEntry> {
        if seconds == 0 {
            return None;
        }
        let entry = runtime
            .data
            .accounts
            .entry(user_id.to_string())
            .or_default()
            .entry(app_id.to_string())
            .or_insert_with(|| GameSimulationHistoryEntry {
                app_id: app_id.to_string(),
                app_name: app_name.to_string(),
                total_seconds: 0,
                updated_at: chrono::Utc::now().to_rfc3339(),
            });
        entry.app_name = app_name.to_string();
        entry.total_seconds = entry.total_seconds.saturating_add(seconds);
        entry.updated_at = chrono::Utc::now().to_rfc3339();
        Some(entry.clone())
    }

    pub async fn begin<R: Runtime>(
        self: &Arc<Self>,
        path: PathBuf,
        app: tauri::AppHandle<R>,
        user_id: String,
        app_id: String,
        app_name: String,
    ) -> Result<(), String> {
        self.ensure_loaded(&path).await?;
        let usage_id = {
            let mut runtime = self.runtime.lock().await;
            if runtime
                .active
                .iter()
                .any(|usage| usage.user_id == user_id && usage.app_id == app_id)
            {
                return Err(format!(
                    "{app_name} is already being recorded; stop it before starting another instance"
                ));
            }
            let entry = runtime
                .data
                .accounts
                .entry(user_id.clone())
                .or_default()
                .entry(app_id.clone())
                .or_insert_with(|| GameSimulationHistoryEntry {
                    app_id: app_id.clone(),
                    app_name: app_name.clone(),
                    total_seconds: 0,
                    updated_at: chrono::Utc::now().to_rfc3339(),
                });
            entry.app_name = app_name.clone();
            entry.updated_at = chrono::Utc::now().to_rfc3339();
            Self::save_locked(&runtime, &path)?;
            runtime.next_usage_id = runtime.next_usage_id.saturating_add(1);
            let usage_id = runtime.next_usage_id;
            runtime.active.push(ActiveUsage {
                id: usage_id,
                user_id,
                app_id,
                app_name,
                path: path.clone(),
                checkpoint_at: Instant::now(),
                pending_finish_seconds: None,
            });
            usage_id
        };

        let history = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
            interval.tick().await;
            loop {
                interval.tick().await;
                match history.checkpoint(usage_id, &path).await {
                    Ok(Some(entry)) => {
                        let _ = app.emit("game-simulation-history-updated", entry);
                    }
                    Ok(None) => break,
                    Err(error) => {
                        // Keep retrying on the next minute. `checkpoint` rolls
                        // back the failed addition and deliberately preserves
                        // its time marker, so a transient filesystem failure is
                        // recovered without losing or double-counting time.
                        eprintln!("Game simulation history checkpoint failed: {error}");
                    }
                }
            }
        });
        Ok(())
    }

    async fn checkpoint(
        &self,
        usage_id: u64,
        path: &Path,
    ) -> Result<Option<GameSimulationHistoryEntry>, String> {
        let mut runtime = self.runtime.lock().await;
        let Some(index) = runtime.active.iter().position(|usage| usage.id == usage_id) else {
            return Ok(None);
        };
        if runtime.active[index].pending_finish_seconds.is_some() {
            // Native activity has stopped and final persistence is waiting for
            // an explicit retry. The frozen interval must not keep growing.
            return Ok(None);
        }
        let (user_id, app_id, app_name) = {
            let active = &runtime.active[index];
            (
                active.user_id.clone(),
                active.app_id.clone(),
                active.app_name.clone(),
            )
        };
        let seconds = runtime.active[index].checkpoint_at.elapsed().as_secs();
        if seconds == 0 {
            return Ok(Some(GameSimulationHistoryEntry {
                app_id: app_id.clone(),
                app_name: app_name.clone(),
                total_seconds: runtime
                    .data
                    .accounts
                    .get(&user_id)
                    .and_then(|apps| apps.get(&app_id))
                    .map(|entry| entry.total_seconds)
                    .unwrap_or(0),
                updated_at: chrono::Utc::now().to_rfc3339(),
            }));
        }
        // Snapshot the entry before mutating so a failed save can be reverted
        // exactly. See the rollback below for why that matters.
        let previous_entry = runtime
            .data
            .accounts
            .get(&user_id)
            .and_then(|apps| apps.get(&app_id))
            .cloned();

        // Add the elapsed interval and persist it *before* advancing the
        // checkpoint marker. If persistence fails, `checkpoint_at` still points
        // at the start of the unsaved interval, so the same duration is retried
        // (or captured by `finish`) instead of being silently dropped.
        let entry = Self::add_elapsed(&mut runtime, &user_id, &app_id, &app_name, seconds);
        if let Err(error) = Self::save_locked(&runtime, path) {
            // Revert the in-memory addition. `checkpoint_at` is deliberately not
            // advanced, so `finish` will measure this same interval again;
            // leaving the total inflated here would double-count it.
            if let Some(apps) = runtime.data.accounts.get_mut(&user_id) {
                match previous_entry {
                    Some(previous) => {
                        apps.insert(app_id, previous);
                    }
                    None => {
                        apps.remove(&app_id);
                    }
                }
            }
            return Err(error);
        }
        runtime.active[index].checkpoint_at += std::time::Duration::from_secs(seconds);
        Ok(entry)
    }

    /// Finish every active segment in a single save so a Stop, logout, or exit
    /// cannot leave one game's play time unrecorded while another was written.
    pub async fn finish_all<R: Runtime>(
        &self,
        path: &Path,
        app: Option<&tauri::AppHandle<R>>,
    ) -> Result<Vec<GameSimulationHistoryEntry>, String> {
        self.ensure_loaded(path).await?;
        let mut runtime = self.runtime.lock().await;
        if runtime.active.is_empty() {
            return Ok(Vec::new());
        }

        // Freeze each segment's interval first: a failed save must stay retryable
        // with exactly the duration it had at the moment of failure.
        let mut segments = Vec::with_capacity(runtime.active.len());
        for active in runtime.active.iter_mut() {
            let seconds = active
                .pending_finish_seconds
                .unwrap_or_else(|| active.checkpoint_at.elapsed().as_secs());
            active.pending_finish_seconds = Some(seconds);
            segments.push(SegmentRecord {
                user_id: active.user_id.clone(),
                app_id: active.app_id.clone(),
                app_name: active.app_name.clone(),
                seconds,
            });
        }

        let mut previous_entries = Vec::with_capacity(segments.len());
        for segment in &segments {
            let previous = runtime
                .data
                .accounts
                .get(&segment.user_id)
                .and_then(|apps| apps.get(&segment.app_id))
                .cloned();
            previous_entries.push((segment.user_id.clone(), segment.app_id.clone(), previous));
        }

        let mut entries = Vec::new();
        for segment in &segments {
            if let Some(entry) = Self::add_elapsed(
                &mut runtime,
                &segment.user_id,
                &segment.app_id,
                &segment.app_name,
                segment.seconds,
            ) {
                entries.push(entry);
            }
        }

        if let Err(error) = Self::save_locked(&runtime, path) {
            for (user_id, app_id, previous_entry) in previous_entries {
                if let Some(apps) = runtime.data.accounts.get_mut(&user_id) {
                    match previous_entry {
                        Some(previous) => {
                            apps.insert(app_id, previous);
                        }
                        None => {
                            apps.remove(&app_id);
                        }
                    }
                }
            }
            return Err(error);
        }

        // Only release the segments after their final intervals are durable.
        // A failed save deliberately leaves them active so Stop can be retried.
        runtime.active.clear();
        if let Some(app) = app {
            for entry in entries.iter() {
                let _ = app.emit("game-simulation-history-updated", entry.clone());
            }
        }
        Ok(entries)
    }

    /// Finish the segment belonging to one application, leaving the others running.
    pub async fn finish_one<R: Runtime>(
        &self,
        path: &Path,
        app: Option<&tauri::AppHandle<R>>,
        app_id: &str,
    ) -> Result<Option<GameSimulationHistoryEntry>, String> {
        self.ensure_loaded(path).await?;
        let mut runtime = self.runtime.lock().await;
        let Some(index) = runtime
            .active
            .iter()
            .position(|usage| usage.app_id == app_id)
        else {
            return Ok(None);
        };

        let seconds = {
            let active = &mut runtime.active[index];
            let seconds = active
                .pending_finish_seconds
                .unwrap_or_else(|| active.checkpoint_at.elapsed().as_secs());
            active.pending_finish_seconds = Some(seconds);
            seconds
        };
        let (user_id, segment_app_id, app_name) = {
            let active = &runtime.active[index];
            (
                active.user_id.clone(),
                active.app_id.clone(),
                active.app_name.clone(),
            )
        };
        let previous_entry = runtime
            .data
            .accounts
            .get(&user_id)
            .and_then(|apps| apps.get(&segment_app_id))
            .cloned();

        let entry = Self::add_elapsed(&mut runtime, &user_id, &segment_app_id, &app_name, seconds);
        if let Err(error) = Self::save_locked(&runtime, path) {
            if let Some(apps) = runtime.data.accounts.get_mut(&user_id) {
                match previous_entry {
                    Some(previous) => {
                        apps.insert(segment_app_id, previous);
                    }
                    None => {
                        apps.remove(&segment_app_id);
                    }
                }
            }
            return Err(error);
        }
        runtime.active.remove(index);
        if let (Some(app), Some(entry)) = (app, entry.as_ref()) {
            let _ = app.emit("game-simulation-history-updated", entry.clone());
        }
        Ok(entry)
    }

    /// Finish every active segment using the paths captured when they began.
    /// Cleanup must not depend on resolving the application data directory a
    /// second time after the native simulation has already started.
    pub async fn finish_active<R: Runtime>(
        &self,
        app: Option<&tauri::AppHandle<R>>,
    ) -> Result<Vec<GameSimulationHistoryEntry>, String> {
        let mut paths: Vec<PathBuf> = Vec::new();
        {
            let runtime = self.runtime.lock().await;
            for active in &runtime.active {
                if !paths.contains(&active.path) {
                    paths.push(active.path.clone());
                }
            }
        }
        // Segments are finished per history file so one save stays atomic for
        // the segments it covers. A failing file leaves only its own segments
        // active, so a retried Stop still has something to finish.
        let mut entries = Vec::new();
        let mut failure = None::<String>;
        for path in &paths {
            match self.finish_all(path, app).await {
                Ok(finished) => entries.extend(finished),
                Err(error) => {
                    if failure.is_none() {
                        failure = Some(error);
                    }
                }
            }
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(entries),
        }
    }

    pub async fn entries_for_user(
        &self,
        path: &Path,
        user_id: &str,
    ) -> Result<Vec<GameSimulationHistoryEntry>, String> {
        self.ensure_loaded(path).await?;
        let runtime = self.runtime.lock().await;
        let mut entries: Vec<_> = runtime
            .data
            .accounts
            .get(user_id)
            .map(|apps| apps.values().cloned().collect())
            .unwrap_or_default();
        entries.sort_by(|left, right| left.app_name.cmp(&right.app_name));
        Ok(entries)
    }

    pub async fn status(&self) -> SimulationHistoryStatus {
        let runtime = self.runtime.lock().await;
        let segments: Vec<SimulationHistorySegment> = runtime
            .active
            .iter()
            .map(|active| SimulationHistorySegment {
                app_id: active.app_id.clone(),
                app_name: active.app_name.clone(),
                pending_finish: active.pending_finish_seconds.is_some(),
            })
            .collect();
        let first = segments.first();
        SimulationHistoryStatus {
            active: !segments.is_empty(),
            pending_finish: segments.iter().any(|segment| segment.pending_finish),
            app_id: first.map(|segment| segment.app_id.clone()),
            app_name: first.map(|segment| segment.app_name.clone()),
            segments,
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(temporary: &Path, target: &Path) -> Result<(), String> {
    std::fs::rename(temporary, target)
        .map_err(|error| format!("Failed to commit game simulation history: {error}"))
}

#[cfg(target_os = "windows")]
fn replace_file(temporary: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return std::fs::rename(temporary, target)
            .map_err(|error| format!("Failed to commit game simulation history: {error}"));
    }

    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{ReplaceFileW, REPLACE_FILE_FLAGS};

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    let temporary_wide: Vec<u16> = temporary.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe {
        ReplaceFileW(
            PCWSTR(target_wide.as_ptr()),
            PCWSTR(temporary_wide.as_ptr()),
            PCWSTR::null(),
            REPLACE_FILE_FLAGS(0),
            None,
            None,
        )
    }
    .map_err(|error| format!("Failed to atomically replace game simulation history: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn active_usage(
        id: u64,
        user_id: &str,
        app_id: &str,
        app_name: &str,
        path: PathBuf,
    ) -> ActiveUsage {
        ActiveUsage {
            id,
            user_id: user_id.into(),
            app_id: app_id.into(),
            app_name: app_name.into(),
            path,
            checkpoint_at: Instant::now(),
            pending_finish_seconds: None,
        }
    }

    #[test]
    fn elapsed_time_is_isolated_by_account_and_app() {
        let mut runtime = HistoryRuntime::default();
        let _ = SimulationHistory::add_elapsed(&mut runtime, "account-a", "app-a", "Game A", 65);
        let _ = SimulationHistory::add_elapsed(&mut runtime, "account-b", "app-a", "Game A", 30);
        assert_eq!(
            runtime.data.accounts["account-a"]["app-a"].total_seconds,
            65
        );
        assert_eq!(
            runtime.data.accounts["account-b"]["app-a"].total_seconds,
            30
        );
    }

    #[tokio::test]
    async fn persisted_history_is_recovered_by_a_new_store() {
        let path =
            std::env::temp_dir().join(format!("dqh-game-history-{}.json", uuid::Uuid::new_v4()));
        let first = SimulationHistory::default();
        let game = "Game A";
        first.ensure_loaded(&path).await.unwrap();
        {
            let mut runtime = first.runtime.lock().await;
            runtime.active.push(active_usage(
                1,
                "account-a",
                "app-a",
                "Game A",
                path.clone(),
            ));
            let _ = SimulationHistory::add_elapsed(&mut runtime, "account-a", "app-a", game, 125);
            runtime.active.clear();
            SimulationHistory::save_locked(&runtime, &path).unwrap();
        }

        let recovered = SimulationHistory::default();
        recovered.ensure_loaded(&path).await.unwrap();
        let runtime = recovered.runtime.lock().await;
        assert_eq!(
            runtime.data.accounts["account-a"]["app-a"].total_seconds,
            125
        );
        drop(runtime);

        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("json.tmp"));
    }

    #[tokio::test]
    async fn corrupt_history_is_quarantined_and_replaced_with_an_empty_one() {
        let path =
            std::env::temp_dir().join(format!("dqh-corrupt-history-{}.json", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"{ this is not valid json").unwrap();

        let history = SimulationHistory::default();
        history
            .ensure_loaded(&path)
            .await
            .expect("a corrupt file must not make history loading fail permanently");

        {
            let runtime = history.runtime.lock().await;
            assert!(runtime.loaded);
            assert_eq!(runtime.data.version, HISTORY_VERSION);
            assert!(runtime.data.accounts.is_empty());
        }

        let file_name = path.file_name().unwrap().to_string_lossy().into_owned();
        let quarantine = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|candidate| {
                candidate.file_name().is_some_and(|name| {
                    name.to_string_lossy()
                        .starts_with(&format!("{file_name}.corrupt-"))
                })
            })
            .expect("the unreadable file should be preserved under a unique .corrupt name");
        assert!(
            !path.exists() && quarantine.exists(),
            "the unreadable file should be preserved under a unique .corrupt name"
        );

        let _ = std::fs::remove_file(&quarantine);
    }

    #[tokio::test]
    async fn failed_checkpoint_reverts_the_unpersisted_interval() {
        // A regular file used as a parent directory makes `create_dir_all`
        // (and therefore `save_locked`) fail deterministically.
        let blocker =
            std::env::temp_dir().join(format!("dqh-ckpt-blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("history.json");

        let history = SimulationHistory::default();
        {
            let mut runtime = history.runtime.lock().await;
            let mut usage = active_usage(1, "account-a", "app-a", "Game A", path.clone());
            usage.checkpoint_at -= std::time::Duration::from_secs(5);
            runtime.active.push(usage);
        }

        assert!(
            history.checkpoint(1, &path).await.is_err(),
            "checkpoint must report the persistence failure"
        );

        let runtime = history.runtime.lock().await;
        assert!(
            runtime
                .data
                .accounts
                .get("account-a")
                .and_then(|apps| apps.get("app-a"))
                .is_none(),
            "a failed checkpoint must not leave the interval counted in memory"
        );
        let active = runtime
            .active
            .first()
            .expect("the active usage is still tracked");
        assert!(
            active.checkpoint_at.elapsed() >= std::time::Duration::from_secs(5),
            "the checkpoint marker must not advance, so `finish` still captures the interval"
        );
        drop(runtime);

        let _ = std::fs::remove_file(&blocker);
    }

    #[tokio::test]
    async fn checkpoint_retains_the_fractional_interval() {
        let path =
            std::env::temp_dir().join(format!("dqh-ckpt-fraction-{}.json", uuid::Uuid::new_v4()));
        let history = SimulationHistory::default();
        {
            let mut runtime = history.runtime.lock().await;
            let mut usage = active_usage(1, "account-a", "app-a", "Game A", path.clone());
            usage.checkpoint_at -= std::time::Duration::from_millis(1_500);
            runtime.active.push(usage);
        }

        history.checkpoint(1, &path).await.unwrap();
        let runtime = history.runtime.lock().await;
        let recorded = runtime.data.accounts["account-a"]["app-a"].total_seconds;
        let carried = runtime.active.first().unwrap().checkpoint_at.elapsed();
        let total = carried + std::time::Duration::from_secs(recorded);
        assert!(recorded >= 1, "the whole seconds must be persisted");
        assert!(total >= std::time::Duration::from_millis(1_500), "no time may be lost");
        drop(runtime);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn failed_finish_preserves_the_active_interval_for_retry() {
        let blocker =
            std::env::temp_dir().join(format!("dqh-finish-blocker-{}", uuid::Uuid::new_v4()));
        std::fs::write(&blocker, b"not a directory").unwrap();
        let path = blocker.join("history.json");

        let history = SimulationHistory::default();
        {
            let mut runtime = history.runtime.lock().await;
            let mut usage = active_usage(1, "account-a", "app-a", "Game A", path.clone());
            usage.checkpoint_at -= std::time::Duration::from_secs(5);
            runtime.active.push(usage);
        }

        let result = history.finish_all::<tauri::Wry>(&path, None).await;
        assert!(result.is_err());

        let runtime = history.runtime.lock().await;
        let active = runtime
            .active
            .first()
            .expect("the final interval must remain retryable");
        assert!(
            active.pending_finish_seconds.is_some_and(|seconds| seconds >= 5),
            "the frozen interval must stay retryable"
        );
        assert!(
            runtime
                .data
                .accounts
                .get("account-a")
                .and_then(|apps| apps.get("app-a"))
                .is_none(),
            "a failed final save must not remain counted only in memory"
        );
        drop(runtime);

        let _ = std::fs::remove_file(&blocker);
    }

    #[tokio::test]
    async fn finish_one_records_only_the_selected_segment() {
        let path = std::env::temp_dir().join(format!("dqh-parallel-{}.json", uuid::Uuid::new_v4()));
        let history = SimulationHistory::default();
        history.ensure_loaded(&path).await.unwrap();
        {
            let mut runtime = history.runtime.lock().await;
            let first = active_usage(1, "account-a", "app-a", "Game A", path.clone());
            let second = active_usage(2, "account-a", "app-b", "Game B", path.clone());
            runtime.active.push(first);
            runtime.active.push(second);
            runtime.active[0].checkpoint_at -= std::time::Duration::from_secs(40);
            runtime.active[1].checkpoint_at -= std::time::Duration::from_secs(70);
        }

        let finished = history.finish_one::<tauri::Wry>(&path, None, "app-a").await;
        let entry = finished.unwrap().expect("the stopped segment is reported");
        assert!(entry.total_seconds >= 40, "the whole interval is reported");

        let runtime = history.runtime.lock().await;
        assert_eq!(runtime.active.len(), 1, "the other game keeps recording");
        assert_eq!(runtime.active[0].app_id, "app-b");
        let apps = &runtime.data.accounts["account-a"];
        assert_eq!(apps["app-a"].total_seconds, entry.total_seconds);
        assert!(
            apps.get("app-b").is_none(),
            "a segment that is still active must not be written by finish_one"
        );
        drop(runtime);

        let rest = history.finish_all::<tauri::Wry>(&path, None).await;
        let entries = rest.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].app_id, "app-b");
        assert!(history.runtime.lock().await.active.is_empty());
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn status_lists_every_active_segment() {
        let history = SimulationHistory::default();
        {
            let mut runtime = history.runtime.lock().await;
            let first = active_usage(1, "account-a", "app-a", "Game A", PathBuf::new());
            let mut second = active_usage(2, "account-a", "app-b", "Game B", PathBuf::new());
            second.pending_finish_seconds = Some(3);
            runtime.active.push(first);
            runtime.active.push(second);
        }

        let status = history.status().await;
        assert!(status.active);
        assert_eq!(status.segments.len(), 2);
        assert_eq!(status.app_id.as_deref(), Some("app-a"));
        assert!(status.pending_finish);
    }
}
