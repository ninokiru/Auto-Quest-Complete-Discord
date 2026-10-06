// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    auto_quest_complete_discord_lib::initialize_runtime_identity_and_run();
}
