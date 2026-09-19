use std::path::PathBuf;
use std::time::Duration;

use kinesis_sync_server::config::Config;
use kinesis_sync_server::{build_state, scan_once, serve};

fn usage() -> ! {
    eprintln!("usage: kinesis-sync-server [--config <path>]   (default: config.toml)");
    std::process::exit(2);
}

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let mut config_path = PathBuf::from("config.toml");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" | "-c" => config_path = args.next().map(PathBuf::from).unwrap_or_else(|| usage()),
            _ => usage(),
        }
    }

    let config = match Config::load(&config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };
    let bind = config.bind.clone();
    let interval = config.scan_interval_secs;
    let state = match build_state(config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(1);
        }
    };

    // The first scan must succeed: serving from an unreadable master would only hide the problem.
    let first = {
        let state = state.clone();
        tokio::task::spawn_blocking(move || scan_once(&state)).await.expect("scan task panicked")
    };
    match first {
        Ok(stats) => log::info!("initial scan: {} changed, {} removed, revision {}", stats.changed, stats.removed, stats.head),
        Err(e) => {
            eprintln!("error: initial scan failed: {e}");
            std::process::exit(1);
        }
    }

    if interval > 0 {
        let state = state.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(Duration::from_secs(interval));
            ticker.tick().await; // the immediate tick; the initial scan already ran
            loop {
                ticker.tick().await;
                let st = state.clone();
                match tokio::task::spawn_blocking(move || scan_once(&st)).await {
                    Ok(Ok(stats)) if stats.changed + stats.removed > 0 => {
                        log::info!("scan: {} changed, {} removed, revision {}", stats.changed, stats.removed, stats.head)
                    }
                    Ok(Ok(_)) => {}
                    // A failed scan keeps serving the last good state.
                    Ok(Err(e)) => log::error!("scan failed: {e}"),
                    Err(e) => log::error!("scan task failed: {e}"),
                }
            }
        });
    }

    let listener = match tokio::net::TcpListener::bind(&bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("error: can't listen on {bind}: {e}");
            std::process::exit(1);
        }
    };
    log::info!("listening on http://{bind}");
    if let Err(e) = serve(listener, state).await {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
