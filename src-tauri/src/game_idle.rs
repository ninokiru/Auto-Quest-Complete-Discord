use crate::models::DetectableGame;
use crate::simulation_history::SimulationHistory;
use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;

const UPCOMING_LENGTH: usize = 5;
const RECENT_LENGTH: usize = 5;
const MAX_CONSECUTIVE_FAILURES: usize = 5;
/// Upper bound on games simulated at the same time. Discord detects every
/// simulated process, but only one lane can hold the rich-presence slot, so the
/// additional lanes are reported through process detection alone.
const MAX_CONCURRENT_GAMES: usize = 36;
/// How long a lane waits before retrying when every candidate is already held
/// by another lane. A pool smaller than the lane count is a normal configuration
/// during a rest gap, not a failure.
const LANE_RETRY_DELAY: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GameIdleMode {
    Process,
    Cdp,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameIdleConfig {
    pub mode: GameIdleMode,
    pub play_minutes: u32,
    pub rest_minutes: u32,
    pub concurrent_games: u32,
    pub cdp_port: u16,
    pub simulation_path: String,
}

impl GameIdleConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.play_minutes == 0 {
            return Err("Game simulation duration must be a positive integer".to_string());
        }
        if !(1..=(MAX_CONCURRENT_GAMES as u32)).contains(&self.concurrent_games) {
            return Err(format!(
                "Simultaneous games must be 1 to {MAX_CONCURRENT_GAMES}"
            ));
        }
        if self.mode == GameIdleMode::Cdp && self.cdp_port == 0 {
            return Err("CDP port must be between 1 and 65535".to_string());
        }
        if self.mode == GameIdleMode::Process && self.simulation_path.trim().is_empty() {
            return Err("Simulation directory is required for process mode".to_string());
        }
        Ok(())
    }

    /// Lanes this config may actually run. A CDP spoof is written into the
    /// Discord client by `start_manual_game_spoof`, which always clears the
    /// previous spoof first, so CDP is single-lane whatever the request asks.
    pub fn lanes(&self) -> usize {
        match self.mode {
            GameIdleMode::Cdp => 1,
            GameIdleMode::Process => self.concurrent_games as usize,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameIdleItem {
    pub id: String,
    pub name: String,
    pub icon: Option<String>,
    pub type_name: Option<String>,
    /// Stable identity for this occurrence in the idle reel. The same Discord
    /// application can appear again in a later shuffle cycle.
    pub occurrence_id: String,
    #[serde(skip)]
    executable_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GameIdlePhase {
    Starting,
    Playing,
    Resting,
    Stopping,
    Error,
    Stopped,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameIdleLane {
    pub item: GameIdleItem,
    /// `Starting`, `Playing` or `Resting`: the states a lane can be in while the
    /// session is live.
    pub phase: GameIdlePhase,
    pub started_at: i64,
    pub ends_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameIdleStatus {
    pub session_id: String,
    pub mode: GameIdleMode,
    /// Session-wide summary of `lanes`, plus the explicit `Stopping`, `Error`
    /// and `Stopped` states the manager sets itself.
    pub phase: GameIdlePhase,
    pub play_minutes: u32,
    pub rest_minutes: u32,
    pub concurrent_games: u32,
    pub lanes: Vec<GameIdleLane>,
    pub recent: Vec<GameIdleItem>,
    pub upcoming: Vec<GameIdleItem>,
    pub accumulated_played_seconds: u64,
    pub warning: Option<String>,
}

#[derive(Debug, Clone)]
enum RunningSimulation {
    Process { executable_name: String },
    Cdp { port: u16 },
}

struct StartSimulationError {
    message: String,
    /// A native resource whose cleanup failed. Stop must keep owning it so a
    /// retry can finish the job instead of orphaning a simulated game.
    running: Option<RunningSimulation>,
}

impl StartSimulationError {
    fn new(message: String) -> Self {
        Self {
            message,
            running: None,
        }
    }
}

impl From<String> for StartSimulationError {
    fn from(message: String) -> Self {
        Self::new(message)
    }
}

/// One concurrent lane, owned by the worker whose `slot` this is.
#[derive(Debug, Clone)]
struct LaneRecord {
    slot: usize,
    item: GameIdleItem,
    running: Option<RunningSimulation>,
    /// Whether this lane holds the single Discord rich-presence slot.
    presence: bool,
    phase: GameIdlePhase,
    started_at: i64,
    ends_at: Option<i64>,
}

#[derive(Debug)]
struct IdleShared {
    status: GameIdleStatus,
    all: Vec<GameIdleItem>,
    bag: Vec<GameIdleItem>,
    removed_this_cycle: HashSet<String>,
    upcoming: VecDeque<GameIdleItem>,
    recent: VecDeque<GameIdleItem>,
    lanes: Vec<LaneRecord>,
    consecutive_failures: usize,
}

impl IdleShared {
    fn refresh_status_lists(&mut self) {
        self.status.recent = self.recent.iter().cloned().collect();
        self.status.upcoming = self.upcoming.iter().cloned().collect();
    }

    /// Publish the lane records and re-derive the session summary. `Stopping`,
    /// `Error` and `Stopped` are set by the manager, so they must never be
    /// overwritten by what the lanes happen to be doing.
    fn sync_lanes(&mut self) {
        self.status.lanes = self
            .lanes
            .iter()
            .map(|lane| GameIdleLane {
                item: lane.item.clone(),
                phase: lane.phase,
                started_at: lane.started_at,
                ends_at: lane.ends_at,
            })
            .collect();
        if matches!(
            self.status.phase,
            GameIdlePhase::Stopping | GameIdlePhase::Error | GameIdlePhase::Stopped
        ) {
            return;
        }
        self.status.phase = if self
            .lanes
            .iter()
            .any(|lane| lane.phase == GameIdlePhase::Playing)
        {
            GameIdlePhase::Playing
        } else if !self.lanes.is_empty()
            && self
                .lanes
                .iter()
                .all(|lane| lane.phase == GameIdlePhase::Resting)
        {
            GameIdlePhase::Resting
        } else {
            GameIdlePhase::Starting
        };
    }

    /// A game held by a live lane must not appear in the queue again: two lanes
    /// playing one application would collide on both the recorded play time and
    /// the simulated process name. A resting lane is released, because its game
    /// is no longer running.
    fn is_claimed(&self, candidate: &GameIdleItem) -> bool {
        self.lanes.iter().any(|lane| {
            lane.phase != GameIdlePhase::Resting
                && (lane.item.id == candidate.id
                    || lane
                        .item
                        .executable_name
                        .as_ref()
                        .is_some_and(|name| Some(name) == candidate.executable_name.as_ref()))
        })
    }

    fn refill_bag(&mut self) {
        // Exhausting the bag ends the current shuffle cycle, so a game the user
        // removed may become eligible again in the next one. Keeping the
        // exclusion across refills would strand it forever: an excluded game
        // never enters `upcoming`, so it could never be played and never
        // released.
        self.removed_this_cycle.clear();
        self.bag = self.all.clone();
        shuffle(&mut self.bag);
    }

    fn fill_upcoming(&mut self) {
        if self.all.is_empty() {
            self.refresh_status_lists();
            return;
        }
        let mut attempts = 0usize;
        let max_attempts = self.all.len().saturating_mul(4).max(20);
        while self.upcoming.len() < UPCOMING_LENGTH && attempts < max_attempts {
            attempts += 1;
            if self.bag.is_empty() {
                self.refill_bag();
            }
            let Some(candidate) = self.bag.pop() else {
                break;
            };
            if self.removed_this_cycle.contains(&candidate.id) {
                continue;
            }
            if self.is_claimed(&candidate) {
                continue;
            }
            if self.upcoming.iter().any(|item| item.id == candidate.id) {
                continue;
            }
            let recently_played = self.recent.iter().any(|item| item.id == candidate.id);
            if recently_played && self.all.len() > UPCOMING_LENGTH + RECENT_LENGTH {
                continue;
            }
            let mut occurrence = candidate;
            occurrence.occurrence_id = uuid::Uuid::new_v4().to_string();
            self.upcoming.push_back(occurrence);
        }
        self.refresh_status_lists();
    }

    /// Claim the next queued game for `slot`. The single rich-presence slot is
    /// given to the first lane that asks while no other lane holds it. Returns
    /// the game and whether this lane may publish it through RPC.
    fn take_candidate(&mut self, slot: usize) -> Option<(GameIdleItem, bool)> {
        if self.upcoming.is_empty() {
            self.fill_upcoming();
        }
        let item = self.upcoming.pop_front()?;
        let presence = self.status.mode == GameIdleMode::Process
            && !self.lanes.iter().any(|lane| lane.presence);
        self.release_lane(slot);
        self.lanes.push(LaneRecord {
            slot,
            item: item.clone(),
            running: None,
            presence,
            phase: GameIdlePhase::Starting,
            started_at: now_millis(),
            ends_at: None,
        });
        self.sync_lanes();
        self.refresh_status_lists();
        Some((item, presence))
    }

    /// Record ownership before play-time persistence begins, so a persistence
    /// failure still leaves the simulation reachable by Stop.
    fn set_lane_running(&mut self, slot: usize, running: RunningSimulation) {
        if let Some(lane) = self.lanes.iter_mut().find(|lane| lane.slot == slot) {
            lane.running = Some(running);
        }
    }

    /// The lane is now playing. The game joins `recent` so the reel keeps
    /// showing it as played while the other lanes carry on.
    fn mark_playing(&mut self, slot: usize, play_minutes: u32) {
        let Some(lane) = self.lanes.iter_mut().find(|lane| lane.slot == slot) else {
            return;
        };
        lane.phase = GameIdlePhase::Playing;
        lane.started_at = now_millis();
        lane.ends_at = Some(lane.started_at + i64::from(play_minutes) * 60_000);
        let item = lane.item.clone();
        if !self.recent.iter().any(|played| played.id == item.id) {
            self.recent.push_back(item);
            while self.recent.len() > RECENT_LENGTH {
                self.recent.pop_front();
            }
        }
        self.fill_upcoming();
        self.sync_lanes();
    }

    /// Account for the time the lane just played. With a rest gap the finished
    /// game stays on screen as a resting lane; without one the lane is released
    /// so its game may be queued again immediately.
    fn end_play(&mut self, slot: usize, played_seconds: u64, rest_minutes: u32) {
        self.status.accumulated_played_seconds = self
            .status
            .accumulated_played_seconds
            .saturating_add(played_seconds);
        if rest_minutes == 0 {
            self.release_lane(slot);
            return;
        }
        let Some(lane) = self.lanes.iter_mut().find(|lane| lane.slot == slot) else {
            return;
        };
        lane.running = None;
        lane.presence = false;
        lane.phase = GameIdlePhase::Resting;
        lane.started_at = now_millis();
        lane.ends_at = Some(lane.started_at + i64::from(rest_minutes) * 60_000);
        self.sync_lanes();
    }

    /// Drop the lane record, freeing its game for other lanes to queue. Returns
    /// the record so a caller can tell whether it still owned a simulation.
    fn release_lane(&mut self, slot: usize) -> Option<LaneRecord> {
        let index = self.lanes.iter().position(|lane| lane.slot == slot)?;
        let lane = self.lanes.remove(index);
        self.sync_lanes();
        Some(lane)
    }

    /// Count a failed lane start and report whether the circuit breaker tripped.
    fn register_failure(&mut self, message: String) -> bool {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.status.warning = Some(message);
        self.fill_upcoming();
        self.sync_lanes();
        self.consecutive_failures >= MAX_CONSECUTIVE_FAILURES
    }

    fn register_success(&mut self) {
        self.consecutive_failures = 0;
    }

    fn remove_upcoming_item(&mut self, app_id: &str, occurrence_id: &str) -> bool {
        let Some(position) = self
            .upcoming
            .iter()
            .position(|item| item.id == app_id && item.occurrence_id == occurrence_id)
        else {
            return false;
        };
        self.upcoming.remove(position);
        self.removed_this_cycle.insert(app_id.to_string());
        self.fill_upcoming();
        // A tiny pool may need to cross into a new shuffle cycle immediately,
        // which clears the cycle exclusion set. Never let the item the user
        // just removed bounce straight back into the visible queue; showing
        // fewer than five candidates is preferable in that case.
        self.upcoming.retain(|item| item.id != app_id);
        self.refresh_status_lists();
        true
    }
}

struct ActiveIdleSession {
    shared: Arc<tokio::sync::Mutex<IdleShared>>,
    cancel: Option<Arc<tokio::sync::watch::Sender<bool>>>,
    joins: Vec<tauri::async_runtime::JoinHandle<()>>,
}

#[derive(Default)]
pub struct GameIdleManager {
    active: tokio::sync::Mutex<Option<ActiveIdleSession>>,
}

impl GameIdleManager {
    pub async fn ensure_idle(&self) -> Result<(), String> {
        if self.active.lock().await.is_some() {
            Err("Stop game idle mode before starting another activity".to_string())
        } else {
            Ok(())
        }
    }

    pub async fn start(
        &self,
        config: GameIdleConfig,
        games: Vec<DetectableGame>,
        user_id: String,
        history: Arc<SimulationHistory>,
        history_path: PathBuf,
        app: tauri::AppHandle,
    ) -> Result<GameIdleStatus, String> {
        config.validate()?;
        let mut active = self.active.lock().await;
        if active.is_some() {
            return Err("Game idle mode is already running".to_string());
        }

        let candidates = eligible_games(config.mode, games);
        if candidates.is_empty() {
            return Err(match config.mode {
                GameIdleMode::Process => {
                    "No Discord-detectable applications have an executable compatible with this system"
                        .to_string()
                }
                GameIdleMode::Cdp => "Discord returned no detectable games or applications".to_string(),
            });
        }

        let lanes = config.lanes();
        let config = Arc::new(config);
        let session_id = uuid::Uuid::new_v4().to_string();
        let status = GameIdleStatus {
            session_id,
            mode: config.mode,
            phase: GameIdlePhase::Starting,
            play_minutes: config.play_minutes,
            rest_minutes: config.rest_minutes,
            concurrent_games: lanes as u32,
            lanes: Vec::new(),
            recent: Vec::new(),
            upcoming: Vec::new(),
            accumulated_played_seconds: 0,
            warning: None,
        };
        let mut shared_value = IdleShared {
            status,
            all: candidates,
            bag: Vec::new(),
            removed_this_cycle: HashSet::new(),
            upcoming: VecDeque::new(),
            recent: VecDeque::new(),
            lanes: Vec::new(),
            consecutive_failures: 0,
        };
        shared_value.refill_bag();
        shared_value.fill_upcoming();
        // Publish the candidate pool before the first lane launches its native
        // process. The UI can render the complete reel immediately, reducing
        // perceived startup latency while the games are prepared.
        let initial = shared_value.status.clone();
        emit_status(&app, &initial);
        let shared = Arc::new(tokio::sync::Mutex::new(shared_value));
        // One sender, one receiver per lane: a single `send(true)` at Stop time
        // wakes every lane from its play or rest sleep.
        let cancel_tx = Arc::new(tokio::sync::watch::channel(false).0);
        let mut joins = Vec::with_capacity(lanes);
        for slot in 0..lanes {
            joins.push(tauri::async_runtime::spawn(run_lane(
                slot,
                Arc::clone(&config),
                Arc::clone(&shared),
                Arc::clone(&cancel_tx),
                cancel_tx.subscribe(),
                user_id.clone(),
                Arc::clone(&history),
                history_path.clone(),
                app.clone(),
            )));
        }
        *active = Some(ActiveIdleSession {
            shared,
            cancel: Some(cancel_tx),
            joins,
        });
        Ok(initial)
    }

    pub async fn status(&self) -> Option<GameIdleStatus> {
        let shared = self
            .active
            .lock()
            .await
            .as_ref()
            .map(|session| Arc::clone(&session.shared));
        match shared {
            Some(shared) => Some(shared.lock().await.status.clone()),
            None => None,
        }
    }

    pub async fn remove_upcoming(
        &self,
        session_id: &str,
        app_id: &str,
        occurrence_id: &str,
        app: &tauri::AppHandle,
    ) -> Result<GameIdleStatus, String> {
        let shared = self
            .active
            .lock()
            .await
            .as_ref()
            .map(|session| Arc::clone(&session.shared))
            .ok_or_else(|| "Game idle mode is not running".to_string())?;
        let mut shared = shared.lock().await;
        if shared.status.session_id != session_id {
            return Err("The game idle session has changed".to_string());
        }
        // A lane's game is no longer in `upcoming`, so it cannot be removed
        // here; the running simulation stays owned by its worker and Stop.
        if !shared.remove_upcoming_item(app_id, occurrence_id) {
            return Err("Only upcoming games can be removed".to_string());
        }
        emit_status(app, &shared.status);
        Ok(shared.status.clone())
    }

    pub async fn stop(
        &self,
        history: Arc<SimulationHistory>,
        app: &tauri::AppHandle,
    ) -> Result<Option<GameIdleStatus>, String> {
        let (shared, joins) = {
            let mut active = self.active.lock().await;
            let Some(session) = active.as_mut() else {
                return Ok(None);
            };
            {
                let mut shared = session.shared.lock().await;
                shared.status.phase = GameIdlePhase::Stopping;
                shared.sync_lanes();
                emit_status(app, &shared.status);
            }
            if let Some(cancel) = session.cancel.take() {
                let _ = cancel.send(true);
            }
            (
                Arc::clone(&session.shared),
                session.joins.drain(..).collect::<Vec<_>>(),
            )
        };

        // Do not abort an in-flight spawn_blocking call: Tokio cannot cancel
        // that OS work, and a cancelled lane could otherwise launch a child
        // after the manager had already declared the session stopped.
        for join in joins {
            let _ = join.await;
        }

        if let Err(error) = stop_remaining_lanes(&shared, app).await {
            let mut shared = shared.lock().await;
            shared.status.phase = GameIdlePhase::Error;
            shared.sync_lanes();
            shared.status.warning = Some(error.clone());
            emit_status(app, &shared.status);
            return Err(error);
        }

        if let Err(error) = history.finish_active(Some(app)).await {
            let mut shared = shared.lock().await;
            shared.status.phase = GameIdlePhase::Error;
            shared.sync_lanes();
            shared.status.warning = Some(error.clone());
            emit_status(app, &shared.status);
            // Keep the manager entry so the user can retry Stop. Its native
            // resources are already gone, while the history segments remain
            // active until their final intervals are durably persisted.
            return Err(error);
        }
        let final_status = {
            let mut shared = shared.lock().await;
            shared.status.phase = GameIdlePhase::Stopped;
            shared.status.lanes = Vec::new();
            emit_status(app, &shared.status);
            shared.status.clone()
        };
        *self.active.lock().await = None;
        Ok(Some(final_status))
    }
}

/// Stop every simulation the session still owns. Runs after all lane workers
/// have exited, so nothing can start a new game beside this cleanup.
async fn stop_remaining_lanes(
    shared: &Arc<tokio::sync::Mutex<IdleShared>>,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut errors = Vec::new();
    // A lane whose cleanup failed keeps its record so a retried Stop can finish
    // the job, but it must not be retried inside this pass forever.
    let mut blocked = HashSet::new();
    loop {
        let pending = {
            let state = shared.lock().await;
            state
                .lanes
                .iter()
                .find(|lane| lane.running.is_some() && !blocked.contains(&lane.slot))
                .cloned()
        };
        let Some(lane) = pending else { break };
        let Some(running) = lane.running else {
            continue;
        };
        match stop_simulation(&running, lane.presence, app).await {
            Ok(()) => {
                shared.lock().await.release_lane(lane.slot);
            }
            Err(error) => {
                blocked.insert(lane.slot);
                errors.push(format!("{}: {error}", lane.item.name));
            }
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Failed to stop simulated games: {}",
            errors.join("; ")
        ))
    }
}

/// One lane of the reel. A lane owns exactly one game at a time and repeats
/// pick, play, stop, rest until the session is cancelled. Each lane gets its own
/// receiver, so a single Stop wakes every one of them at once.
async fn run_lane(
    slot: usize,
    config: Arc<GameIdleConfig>,
    shared: Arc<tokio::sync::Mutex<IdleShared>>,
    cancel_tx: Arc<tokio::sync::watch::Sender<bool>>,
    mut cancel: tokio::sync::watch::Receiver<bool>,
    user_id: String,
    history: Arc<SimulationHistory>,
    history_path: PathBuf,
    app: tauri::AppHandle,
) {
    loop {
        if *cancel.borrow() {
            break;
        }
        let claimed = {
            let mut state = shared.lock().await;
            state.take_candidate(slot)
        };
        let Some((candidate, presence)) = claimed else {
            // Every candidate is held by another lane, which is normal when the
            // pool is smaller than the lane count. Wait for one to be released
            // instead of spinning, and do not count it as a failed start.
            tokio::select! {
                _ = tokio::time::sleep(LANE_RETRY_DELAY) => {}
                _ = cancel.changed() => {}
            }
            continue;
        };
        emit_status(&app, &shared.lock().await.status);

        let mut running = None;
        let mut last_error = String::new();
        let mut unrecoverable = false;
        for attempt in 0..2 {
            match start_simulation(&candidate, &config, presence).await {
                Ok(value) => {
                    running = Some(value);
                    break;
                }
                Err(error) => {
                    last_error = error.message;
                    if let Some(orphan) = error.running {
                        // The attempted rollback failed. Retain ownership for
                        // the normal Stop path instead of launching it again.
                        shared.lock().await.set_lane_running(slot, orphan);
                        unrecoverable = true;
                        break;
                    }
                    if attempt == 0 {
                        tokio::select! {
                            _ = tokio::time::sleep(Duration::from_secs(2)) => {},
                            _ = cancel.changed() => { break; }
                        }
                    }
                }
            }
        }

        if unrecoverable {
            set_error(&shared, &app, last_error).await;
            let _ = cancel_tx.send(true);
            break;
        }

        // Stopping during the retry delay is not a failed game start. Release
        // the lane without emitting a warning or counting a failure.
        if *cancel.borrow() && running.is_none() {
            shared.lock().await.release_lane(slot);
            break;
        }

        let Some(simulation) = running else {
            let tripped = {
                let mut state = shared.lock().await;
                state.release_lane(slot);
                state.register_failure(format!(
                    "Skipped {} after two failed start attempts: {}",
                    candidate.name, last_error
                ))
            };
            emit_status(&app, &shared.lock().await.status);
            if tripped {
                set_error(
                    &shared,
                    &app,
                    "Five games failed to start consecutively. Check Discord and the selected simulation mode."
                        .to_string(),
                )
                .await;
                let _ = cancel_tx.send(true);
                break;
            }
            continue;
        };

        {
            let mut state = shared.lock().await;
            state.register_success();
            // Record ownership before beginning history persistence so any
            // cleanup failure still leaves a retryable Stop path.
            state.set_lane_running(slot, simulation.clone());
        }

        if let Err(error) = history
            .begin(
                history_path.clone(),
                app.clone(),
                user_id.clone(),
                candidate.id.clone(),
                candidate.name.clone(),
            )
            .await
        {
            let cleanup_error = stop_simulation(&simulation, presence, &app).await.err();
            if cleanup_error.is_none() {
                shared.lock().await.release_lane(slot);
            }
            let detail = cleanup_error
                .map(|cleanup| format!("{error}. Cleanup also failed: {cleanup}"))
                .unwrap_or(error);
            set_error(&shared, &app, detail).await;
            let _ = cancel_tx.send(true);
            break;
        }

        let play_started = Instant::now();
        {
            let mut state = shared.lock().await;
            state.mark_playing(slot, config.play_minutes);
        }
        emit_status(&app, &shared.lock().await.status);

        let play_duration = Duration::from_secs(u64::from(config.play_minutes) * 60);
        let cancelled = tokio::select! {
            _ = tokio::time::sleep(play_duration) => false,
            _ = cancel.changed() => true,
        };

        if let Err(error) = stop_simulation(&simulation, presence, &app).await {
            set_error(
                &shared,
                &app,
                format!("Failed to stop {}: {}", candidate.name, error),
            )
            .await;
            let _ = cancel_tx.send(true);
            break;
        }
        {
            let mut state = shared.lock().await;
            state.end_play(slot, play_started.elapsed().as_secs(), config.rest_minutes);
        }
        emit_status(&app, &shared.lock().await.status);
        if let Err(error) = history
            .finish_one(&history_path, Some(&app), &candidate.id)
            .await
        {
            set_error(&shared, &app, error).await;
            let _ = cancel_tx.send(true);
            break;
        }
        if cancelled || *cancel.borrow() {
            break;
        }

        if config.rest_minutes > 0 {
            let rest_duration = Duration::from_secs(u64::from(config.rest_minutes) * 60);
            let interrupted = tokio::select! {
                _ = tokio::time::sleep(rest_duration) => false,
                _ = cancel.changed() => true,
            };
            if interrupted {
                shared.lock().await.release_lane(slot);
                break;
            }
            // The finished game was only parked on screen for the rest gap.
            // Releasing it now lets any lane pick it up again.
            shared.lock().await.release_lane(slot);
        }
    }
}

/// Roll back a simulated process whose launch succeeded but whose presence
/// update failed. When even the rollback fails, the returned error keeps
/// ownership so Stop can retry the cleanup instead of orphaning the process.
async fn rollback_process(executable_name: String, error: String) -> StartSimulationError {
    let executable = executable_name.clone();
    let cleanup = tauri::async_runtime::spawn_blocking(move || {
        crate::game_simulator::stop_simulated_game(&executable)
    })
    .await
    .map_err(|join_error| join_error.to_string())
    .and_then(|result| result.map_err(|stop_error| stop_error.to_string()));
    match cleanup {
        Ok(()) => StartSimulationError::new(error),
        Err(cleanup_error) => StartSimulationError {
            message: format!("{error}. Process cleanup also failed: {cleanup_error}"),
            running: Some(RunningSimulation::Process { executable_name }),
        },
    }
}

async fn start_simulation(
    game: &GameIdleItem,
    config: &GameIdleConfig,
    presence: bool,
) -> Result<RunningSimulation, StartSimulationError> {
    match config.mode {
        GameIdleMode::Process => {
            let executable_name = game
                .executable_name
                .clone()
                .ok_or_else(|| "No compatible executable is available".to_string())?;
            let path = config.simulation_path.clone();
            let name = game.name.clone();
            let app_id = game.id.clone();
            let executable_for_task = executable_name.clone();
            tauri::async_runtime::spawn_blocking(move || {
                crate::game_simulator::create_simulated_game(&path, &executable_for_task, &app_id)?;
                crate::game_simulator::run_simulated_game(
                    &name,
                    &path,
                    &executable_for_task,
                    &app_id,
                )
            })
            .await
            .map_err(|error| format!("Process simulator task failed: {error}"))?
            .map_err(|error| error.to_string())?;

            // Discord has one rich-presence slot, so only the lane that claimed
            // it publishes the activity. The other lanes are still detected
            // through their simulated processes.
            if presence {
                let activity = serde_json::json!({
                    "app_id": game.id,
                    "state": "In Game",
                    "details": format!("Playing {}", game.name),
                    "largeImageKey": "logo",
                    "largeImageText": game.name,
                    "timestamp": chrono::Utc::now().timestamp(),
                });
                if let Err(error) = crate::replace_discord_rpc(activity.to_string()).await {
                    return Err(rollback_process(executable_name, error).await);
                }
            }
            Ok(RunningSimulation::Process { executable_name })
        }
        GameIdleMode::Cdp => {
            crate::cdp_quest::start_manual_game_spoof(config.cdp_port, &game.id, &game.name)
                .await
                .map_err(|error| error.to_string())?;
            Ok(RunningSimulation::Cdp {
                port: config.cdp_port,
            })
        }
    }
}

async fn stop_simulation(
    running: &RunningSimulation,
    clear_presence: bool,
    _app: &tauri::AppHandle,
) -> Result<(), String> {
    match running {
        RunningSimulation::Process { executable_name } => {
            let rpc_error = if clear_presence {
                crate::clear_discord_rpc().await.err()
            } else {
                None
            };
            let executable_name = executable_name.clone();
            let process_error = tauri::async_runtime::spawn_blocking(move || {
                crate::game_simulator::stop_simulated_game(&executable_name)
            })
            .await
            .map_err(|error| format!("Process cleanup task failed: {error}"))?
            .err()
            .map(|error| error.to_string());
            match (rpc_error, process_error) {
                (None, None) => Ok(()),
                (Some(rpc), None) => Err(rpc),
                (None, Some(process)) => Err(process),
                (Some(rpc), Some(process)) => {
                    Err(format!("{rpc}. Process cleanup also failed: {process}"))
                }
            }
        }
        RunningSimulation::Cdp { port } => crate::cdp_quest::stop_manual_game_spoof(*port)
            .await
            .map_err(|error| error.to_string()),
    }
}

fn eligible_games(mode: GameIdleMode, games: Vec<DetectableGame>) -> Vec<GameIdleItem> {
    let mut seen = HashSet::new();
    games
        .into_iter()
        .filter_map(|game| {
            if !seen.insert(game.id.clone()) {
                return None;
            }
            let executable_name = select_executable(&game);
            if mode == GameIdleMode::Process && executable_name.is_none() {
                return None;
            }
            Some(GameIdleItem {
                id: game.id,
                name: game.name,
                icon: game.icon,
                type_name: game.type_name,
                occurrence_id: String::new(),
                executable_name,
            })
        })
        .collect()
}

fn select_executable(game: &DetectableGame) -> Option<String> {
    #[cfg(target_os = "linux")]
    let preferred = "linux";
    #[cfg(not(target_os = "linux"))]
    let preferred = "win32";
    game.executables
        .iter()
        .find(|executable| executable.os == preferred)
        .map(|executable| executable.name.clone())
}

fn shuffle<T>(values: &mut [T]) {
    values.shuffle(&mut rand::rng());
}

async fn set_error(
    shared: &Arc<tokio::sync::Mutex<IdleShared>>,
    app: &tauri::AppHandle,
    error: String,
) {
    let mut state = shared.lock().await;
    state.status.phase = GameIdlePhase::Error;
    state.status.warning = Some(error);
    state.sync_lanes();
    emit_status(app, &state.status);
}

fn emit_status(app: &tauri::AppHandle, status: &GameIdleStatus) {
    let _ = app.emit("game-idle-status-changed", status.clone());
}

fn now_millis() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::GameExecutable;

    fn game(id: &str, os: &str) -> DetectableGame {
        DetectableGame {
            id: id.into(),
            name: format!("Game {id}"),
            executables: vec![GameExecutable {
                name: format!("{id}.exe"),
                os: os.into(),
            }],
            icon: None,
            type_name: Some("Game".into()),
        }
    }

    fn item(index: usize) -> GameIdleItem {
        GameIdleItem {
            id: index.to_string(),
            name: index.to_string(),
            icon: None,
            type_name: None,
            occurrence_id: String::new(),
            executable_name: Some(format!("{index}.exe")),
        }
    }

    fn pool(range: std::ops::Range<usize>) -> Vec<GameIdleItem> {
        range.map(item).collect()
    }

    fn shared_with(mode: GameIdleMode, all: Vec<GameIdleItem>) -> IdleShared {
        IdleShared {
            status: GameIdleStatus {
                session_id: "session".into(),
                mode,
                phase: GameIdlePhase::Starting,
                play_minutes: 1,
                rest_minutes: 0,
                concurrent_games: 1,
                lanes: vec![],
                recent: vec![],
                upcoming: vec![],
                accumulated_played_seconds: 0,
                warning: None,
            },
            all,
            bag: vec![],
            removed_this_cycle: HashSet::new(),
            upcoming: VecDeque::new(),
            recent: VecDeque::new(),
            lanes: vec![],
            consecutive_failures: 0,
        }
    }

    #[test]
    fn duration_validation_rejects_zero_play_time() {
        let config = GameIdleConfig {
            mode: GameIdleMode::Cdp,
            play_minutes: 0,
            rest_minutes: 0,
            concurrent_games: 1,
            cdp_port: 9223,
            simulation_path: String::new(),
        };
        assert!(config.validate().is_err());
    }

    #[test]
    fn concurrent_games_is_bounded_and_cdp_stays_single_lane() {
        let mut config = GameIdleConfig {
            mode: GameIdleMode::Process,
            play_minutes: 1,
            rest_minutes: 0,
            concurrent_games: 1,
            cdp_port: 9223,
            simulation_path: "C:/simulations".to_string(),
        };
        assert!(config.validate().is_ok());
        assert_eq!(config.lanes(), 1);

        config.concurrent_games = MAX_CONCURRENT_GAMES as u32;
        assert!(config.validate().is_ok());
        assert_eq!(config.lanes(), MAX_CONCURRENT_GAMES);

        config.concurrent_games = 0;
        assert!(config.validate().is_err());
        config.concurrent_games = MAX_CONCURRENT_GAMES as u32 + 1;
        assert!(config.validate().is_err());

        // A CDP spoof always clears the previous one, so the request cannot
        // widen the session to more than one lane.
        config.mode = GameIdleMode::Cdp;
        config.concurrent_games = MAX_CONCURRENT_GAMES as u32;
        assert!(config.validate().is_ok());
        assert_eq!(config.lanes(), 1);
    }

    #[test]
    fn cdp_pool_deduplicates_but_keeps_entries_without_executables() {
        let games = vec![
            game("1", "win32"),
            game("1", "win32"),
            DetectableGame {
                id: "2".into(),
                name: "App 2".into(),
                executables: vec![],
                icon: None,
                type_name: Some("App".into()),
            },
        ];
        let eligible = eligible_games(GameIdleMode::Cdp, games);
        assert_eq!(eligible.len(), 2);
    }

    #[test]
    fn process_pool_only_keeps_host_compatible_entries() {
        let eligible = eligible_games(
            GameIdleMode::Process,
            vec![game("windows", "win32"), game("linux", "linux")],
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            eligible
                .iter()
                .map(|game| game.id.as_str())
                .collect::<Vec<_>>(),
            vec!["linux"]
        );
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            eligible
                .iter()
                .map(|game| game.id.as_str())
                .collect::<Vec<_>>(),
            vec!["windows"]
        );
    }

    #[test]
    fn queue_remains_unique_when_the_pool_is_large_enough() {
        let mut shared = shared_with(GameIdleMode::Process, pool(0..20));
        shared.refill_bag();
        shared.fill_upcoming();
        let ids: HashSet<_> = shared
            .upcoming
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(shared.upcoming.len(), UPCOMING_LENGTH);
        assert_eq!(ids.len(), UPCOMING_LENGTH);
    }

    #[test]
    fn removing_from_a_tiny_pool_does_not_immediately_reinsert_the_item() {
        let mut shared = shared_with(GameIdleMode::Process, pool(0..5));
        shared.refill_bag();
        shared.fill_upcoming();
        let removed_item = shared.upcoming.front().unwrap().clone();
        let removed = removed_item.id.clone();

        assert!(!shared.remove_upcoming_item(&removed, "stale-occurrence"));
        assert!(shared.remove_upcoming_item(&removed, &removed_item.occurrence_id));
        assert!(shared.upcoming.iter().all(|item| item.id != removed));
    }

    #[test]
    fn a_removed_item_is_released_once_the_shuffle_cycle_ends() {
        // A pool larger than `UPCOMING_LENGTH + RECENT_LENGTH` keeps the queue
        // free of duplicates and, importantly, leaves the bag non-empty after
        // the removal, so the exclusion is not cleared by a mid-pass refill.
        let mut shared = shared_with(
            GameIdleMode::Process,
            pool(0..(UPCOMING_LENGTH + RECENT_LENGTH + 2)),
        );
        shared.refill_bag();
        shared.fill_upcoming();
        let removed_item = shared.upcoming.front().unwrap().clone();
        let removed = removed_item.id.clone();

        assert!(shared.remove_upcoming_item(&removed, &removed_item.occurrence_id));
        assert!(shared.removed_this_cycle.contains(&removed));

        // The exclusion is scoped to the current shuffle cycle. Holding it
        // across bag refills would strand the game for the rest of the session:
        // an excluded game can never enter `upcoming`, so it can neither be
        // played nor released again.
        shared.refill_bag();
        assert!(
            !shared.removed_this_cycle.contains(&removed),
            "a new shuffle cycle must release the removal exclusion"
        );
    }

    #[test]
    fn a_claimed_lane_holds_a_single_candidate_back_until_it_is_released() {
        let candidates = eligible_games(GameIdleMode::Cdp, vec![game("only", "win32")]);
        let mut shared = shared_with(GameIdleMode::Cdp, candidates);
        shared.refill_bag();
        shared.fill_upcoming();

        assert_eq!(shared.upcoming.len(), 1);
        let first = shared.take_candidate(0).unwrap().0;
        shared.mark_playing(0, 1);

        // The queue must not offer the only candidate to a second lane while
        // the first lane is still running it.
        assert!(
            shared.upcoming.is_empty(),
            "a lane's game must not appear in the queue at the same time"
        );

        shared.end_play(0, 60, 0);
        shared.bag.clear();
        shared.fill_upcoming();

        assert_eq!(shared.upcoming.len(), 1);
        assert_eq!(shared.upcoming.front().unwrap().id, first.id);
        assert_ne!(
            shared.upcoming.front().unwrap().occurrence_id,
            first.occurrence_id
        );
    }

    #[test]
    fn medium_pool_never_duplicates_the_active_queue_across_a_bag_refill() {
        let candidates = eligible_games(
            GameIdleMode::Cdp,
            (0..6)
                .map(|index| game(&index.to_string(), "win32"))
                .collect(),
        );
        let mut shared = shared_with(GameIdleMode::Cdp, candidates.clone());
        // Force a mid-fill cycle boundary after one candidate.
        shared.bag = vec![candidates[1].clone()];
        let claimed = shared.take_candidate(0).unwrap().0;
        shared.mark_playing(0, 1);

        let ids: HashSet<_> = shared
            .upcoming
            .iter()
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(ids.len(), shared.upcoming.len());
        assert!(shared.upcoming.iter().all(|item| item.id != claimed.id));
        assert!(shared
            .upcoming
            .iter()
            .all(|item| !item.occurrence_id.is_empty()));
    }

    #[test]
    fn only_one_lane_claims_the_presence_and_resting_lanes_free_their_games() {
        // Build the pool directly: routing win32-only games through
        // `eligible_games` empties it on a Linux runner, where Process mode
        // needs a native executable.
        let candidates = pool(0..6);
        let mut shared = shared_with(GameIdleMode::Process, candidates);
        shared.refill_bag();

        let first = shared.take_candidate(0).unwrap();
        let second = shared.take_candidate(1).unwrap();
        assert!(first.1, "the first lane claims rich presence");
        assert!(!second.1, "rich presence has a single owner");
        assert_ne!(first.0.id, second.0.id);

        shared.mark_playing(0, 1);
        shared.mark_playing(1, 1);
        assert_eq!(shared.lanes.len(), 2);
        assert_eq!(shared.status.phase, GameIdlePhase::Playing);
        assert!(shared.is_claimed(&first.0));

        shared.end_play(0, 60, 1);
        // A rest gap stops the game, so the record stays on screen but no
        // longer blocks other lanes from queueing the same candidate.
        assert!(!shared.is_claimed(&first.0));
        assert_eq!(shared.status.phase, GameIdlePhase::Playing);
        assert_eq!(shared.status.lanes.len(), 2);

        shared.end_play(1, 60, 1);
        assert_eq!(shared.status.phase, GameIdlePhase::Resting);

        shared.release_lane(0);
        shared.release_lane(1);
        assert!(shared.lanes.is_empty());
        assert_eq!(shared.status.phase, GameIdlePhase::Starting);
    }
}
