pub use discord_sdk as ds;

/// Application identifier for "Andy's Test App" used in the Discord SDK's
/// examples.
pub struct Client {
    pub discord: ds::Discord,
    #[allow(dead_code)]
    pub wheel: ds::wheel::Wheel,
    #[allow(dead_code)]
    pub user: ds::user::User,
}

/// Connect to Discord's local RPC socket.
///
/// Every failure is returned instead of panicking: callers run inside lane
/// tasks, where a panic would kill the task after a game process was already
/// spawned and skip its rollback. Discord being closed is an ordinary case, so
/// the handshake is also bounded — a socket that never answers must not hang a
/// Stop.
pub async fn make_client(app_id: ds::AppId, subs: ds::Subscriptions) -> Result<Client, String> {
    println!("Creating Discord client with app ID: {}", app_id);
    let (wheel, handler) = ds::wheel::Wheel::new(Box::new(|err| {
        println!("Error: {:?}", err);
    }));

    let mut user = wheel.user();

    let discord = ds::Discord::new(ds::DiscordApp::PlainId(app_id), subs, Box::new(handler))
        .map_err(|error| format!("Discord client error: {error}"))?;
    tokio::time::timeout(std::time::Duration::from_secs(10), user.0.changed())
        .await
        .map_err(|_| "Discord did not accept the client".to_string())?
        .map_err(|error| format!("Discord connection closed: {error}"))?;

    let user = match &*user.0.borrow() {
        ds::wheel::UserState::Connected(user) => user.clone(),
        ds::wheel::UserState::Disconnected(err) => {
            return Err(format!("Failed to connect to Discord: {err}"));
        }
    };

    println!("connected to Discord, local user is {:#?}", user);

    Ok(Client {
        discord,
        wheel,
        user,
    })
}
