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

/// Start an HTTP server serving the built app on localhost.
/// Tries a small range of ports and returns the bound port on success.
pub fn start_server(dist_path: PathBuf) -> Result<u16, Box<dyn std::error::Error>> {
    let dist = match find_dist_path(dist_path) {
        Some(p) => p,
        None => {
            return Err("Could not find a dist directory containing index.html".into())
        }
    };

    eprintln!("Starting HTTP server serving: {}", dist.display());

    for port in 1430..1440u16 {
        let bind = format!("127.0.0.1:{}", port);
        match Server::http(&bind) {
            Ok(server) => {
                eprintln!("HTTP server listening on http://{}", bind);
                let dist = Arc::new(dist);
                std::thread::spawn(move || {
                    for request in server.incoming_requests() {
                        let dist_clone = Arc::clone(&dist);
                        std::thread::spawn(move || {
                            if let Err(err) = handle_request(request, &dist_clone) {
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

    Err("Could not bind to any port in range 1430-1439".into())
}

fn handle_request(request: Request, dist_path: &PathBuf) -> Result<(), Box<dyn std::error::Error>> {
    // Normalize requested path and strip query params
    let mut path = request.url().trim_start_matches('/').split('?').next().unwrap_or("").to_string();

    if path.is_empty() {
        path = "index.html".to_string();
    }

    let file_path = dist_path.join(&path);

    // Prevent directory traversal by comparing canonical paths
    let canonical_dist = fs::canonicalize(dist_path).unwrap_or_else(|_| dist_path.clone());
    let canonical_file = fs::canonicalize(&file_path).unwrap_or_else(|_| file_path.clone());

    if !canonical_file.starts_with(&canonical_dist) {
        return request.respond(Response::from_string("Forbidden").with_status_code(403)).map_err(|e| e.into());
    }

    // Try the requested file first; fall back to index.html for SPA routes
    let response = match fs::read(&file_path) {
        Ok(data) => {
            let content_type = get_content_type(&file_path);
            Response::from_data(data)
                .with_header(Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()).unwrap())
                .with_header(Header::from_bytes(&b"Cache-Control"[..], b"no-cache").unwrap())
                .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap())
        }
        Err(_) => {
            // Serve index.html for client-side routes
            let index_path = dist_path.join("index.html");
            match fs::read(&index_path) {
                Ok(data) => Response::from_data(data)
                    .with_header(Header::from_bytes(&b"Content-Type"[..], b"text/html").unwrap())
                    .with_header(Header::from_bytes(&b"Cache-Control"[..], b"no-cache").unwrap())
                    .with_header(Header::from_bytes(&b"Access-Control-Allow-Origin"[..], b"*").unwrap()),
                Err(_) => Response::from_string("Not Found").with_status_code(404),
            }
        }
    };

    request.respond(response)?;
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
