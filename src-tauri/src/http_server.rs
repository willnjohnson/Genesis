#![allow(dead_code)]

use std::path::PathBuf;
use tiny_http::{Server, Request, Response, Header};
use std::sync::Arc;
use std::fs;

/// Try a few locations for the built `dist` folder.
fn find_dist_path(suggested: PathBuf) -> Option<PathBuf> {
    // If the suggested path already looks valid, use it.
    if suggested.join("index.html").exists() {
        return Some(suggested);
    }

    let mut candidates = Vec::new();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.join("dist"));
            candidates.push(parent.join("..").join("dist"));
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("dist"));
    }

    for c in candidates {
        if c.join("index.html").exists() {
            return Some(c);
        }
    }

    None
}

/// Start an HTTP server for YouTube embeds on localhost.
/// Tries a small range of ports and returns the bound port on success.
pub fn start_server() -> Result<u16, Box<dyn std::error::Error>> {
    for port in 1431..1440u16 {
        let bind = format!("127.0.0.1:{}", port);
        match Server::http(&bind) {
            Ok(server) => {
                eprintln!("YouTube embed HTTP server listening on http://{}", bind);
                std::thread::spawn(move || {
                    for request in server.incoming_requests() {
                        std::thread::spawn(move || {
                            if let Err(err) = handle_request(request) {
                                eprintln!("Error handling request: {}", err);
                            }
                        });
                    }
                });
                return Ok(port);
            }
            Err(e) => {
                eprintln!("Failed to bind {}: {}", bind, e);
            }
        }
    }

    Err("Could not bind to any port in range 1431-1439".into())
}

fn handle_youtube_embed(request: Request) -> Result<(), Box<dyn std::error::Error>> {
    // Parse query parameters to get video ID
    let url = request.url();
    let query_start = url.find('?');
    let mut video_id = String::new();
    if let Some(start) = query_start {
        let query = &url[start + 1..];
        let params: Vec<&str> = query.split('&').collect();
        for param in params {
            if param.starts_with("v=") {
                video_id = param[2..].to_string();
                break;
            }
        }
    }

    if video_id.is_empty() {
        return request.respond(Response::from_string("Missing video ID").with_status_code(400)).map_err(|e| e.into());
    }

    let html = format!(
        r#"<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  html, body {{ width: 100%; height: 100%; overflow: hidden; background: #000; }}
  iframe {{ width: 100%; height: 100%; border: none; }}
</style>
</head>
<body>
<iframe
  src="https://www.youtube.com/embed/{}"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  allowfullscreen>
</iframe>
</body>
</html>"#,
        video_id
    );

    let response = Response::from_string(html)
        .with_header(Header::from_bytes(&b"Content-Type"[..], b"text/html").unwrap())
        .with_header(Header::from_bytes(&b"Cache-Control"[..], b"no-cache").unwrap())
        .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap());

    request.respond(response)?;
    Ok(())
}

fn handle_request(request: Request) -> Result<(), Box<dyn std::error::Error>> {
    // Check for YouTube embed endpoint
    if request.url().starts_with("/youtube_embed") {
        return handle_youtube_embed(request);
    }

    // For other requests, return 404
    request.respond(Response::from_string("Not Found").with_status_code(404))?;
    Ok(())
}

fn get_content_type(path: &PathBuf) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html",
        Some("css") => "text/css",
        Some("js") => "application/javascript",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("eot") => "application/vnd.ms-fontobject",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}
