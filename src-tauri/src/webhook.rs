//! Minimal custom webhook for quest events.
//!
//! Built on the `reqwest` dependency the app already ships so the `--locked`
//! CI stays intact — no new crates, no keyring, no image pipeline.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookConfig {
    pub enabled: bool,
    pub url: String,
    pub bearer_token: String,
    pub on_complete: bool,
    pub on_failure: bool,
}

#[derive(Serialize)]
struct WebhookPayload<'a> {
    event: &'a str,
    quest_id: Option<&'a str>,
    name: Option<&'a str>,
    error: Option<&'a str>,
    sent_at: String,
}

/// POST a small JSON document for one quest event. Delivery is best-effort:
/// callers log the failure but never block a quest on it.
pub async fn send(
    config: &WebhookConfig,
    event: &str,
    quest_id: Option<&str>,
    name: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    if !config.enabled {
        return Ok(());
    }
    let wanted = match event {
        "quest_completed" => config.on_complete,
        "quest_failed" => config.on_failure,
        "test" => true,
        _ => false,
    };
    if !wanted {
        return Ok(());
    }
    if config.url.trim().is_empty() {
        return Err("Webhook URL is empty".to_string());
    }
    let url = url::Url::parse(config.url.trim())
        .map_err(|error| format!("Invalid webhook URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Webhook URL must be http or https".to_string());
    }

    let payload = WebhookPayload {
        event,
        quest_id,
        name,
        error,
        sent_at: chrono::Utc::now().to_rfc3339(),
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| format!("Could not build the webhook client: {error}"))?;
    let mut request = client.post(url).json(&payload);
    if !config.bearer_token.is_empty() {
        request = request.bearer_auth(&config.bearer_token);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Webhook request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("The webhook endpoint answered with {status}"));
    }
    Ok(())
}
