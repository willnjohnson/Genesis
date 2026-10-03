use tiny_http::{Server, Request, Response, Header};

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

/// YouTube video IDs are always an 11-character string of `[A-Za-z0-9_-]`.
/// Enforcing this strictly means the ID can never break out of the `src="..."`
/// attribute it's interpolated into below, without needing an HTML-escaping pass.
fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn handle_youtube_embed(request: Request) -> Result<(), Box<dyn std::error::Error>> {
    // Parse query parameters to get video ID
    let url = request.url();
    let query_start = url.find('?');
    let mut video_id = String::new();
    // Where to start, in whole seconds (a timed video link, see src/lib/internal-links.ts): passed on as YouTube's own
    // `start`. Only digits are taken, so like the id it can't break out of the address it goes into.
    let mut start_at: Option<u32> = None;
    if let Some(start) = query_start {
        let query = &url[start + 1..];
        for param in query.split('&') {
            if let Some(v) = param.strip_prefix("v=") {
                video_id = v.to_string();
            } else if let Some(t) = param.strip_prefix("t=") {
                start_at = t.parse().ok();
            }
        }
    }
    let start_param = start_at.filter(|&t| t > 0).map(|t| format!("&start={t}")).unwrap_or_default();
    let video_id = urlencoding::decode(&video_id).map(|c| c.into_owned()).unwrap_or(video_id);

    if !is_valid_video_id(&video_id) {
        return request.respond(Response::from_string("Invalid video ID").with_status_code(400)).map_err(|e| e.into());
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
  id="player"
  src="https://www.youtube.com/embed/{}?enablejsapi=1{}"
  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
  allowfullscreen>
</iframe>
<script>
  // Between the app (Sidebar.tsx) and YouTube's player, through its iframe API (enablejsapi above):
  //  - kinesis-seek: jump to a moment (the app's [1:23] timestamps and timed links).
  //  - kinesis-time: where the video is now (the app's "Copy link at time"), answered to whoever asked.
  // Only well-formed requests from the window holding this page are acted on.
  var player = document.getElementById('player');
  var current = null;
  var send = function (func, args) {{
    player.contentWindow.postMessage(JSON.stringify({{ event: 'command', func: func, args: args }}), 'https://www.youtube.com');
  }};
  // Asking to listen makes the player report on itself (its time among it) from then on.
  player.addEventListener('load', function () {{
    player.contentWindow.postMessage(JSON.stringify({{ event: 'listening', id: 'kinesis', channel: 'widget' }}), 'https://www.youtube.com');
  }});
  window.addEventListener('message', function (e) {{
    if (e.source === player.contentWindow) {{
      if (e.origin !== 'https://www.youtube.com' || typeof e.data !== 'string') return;
      try {{
        var info = JSON.parse(e.data).info;
        if (info && typeof info.currentTime === 'number') current = info.currentTime;
      }} catch (_) {{}}
      return;
    }}
    var d = e.data;
    if (e.source !== window.parent || !d) return;
    if (d.type === 'kinesis-time') {{
      e.source.postMessage({{ type: 'kinesis-time', id: d.id, seconds: current }}, e.origin);
      return;
    }}
    if (d.type !== 'kinesis-seek') return;
    var s = d.seconds;
    if (typeof s !== 'number' || !isFinite(s) || s < 0) return;
    send('seekTo', [s, true]);
    send('playVideo', []);
  }});
</script>
</body>
</html>"#,
        video_id, start_param
    );

    let response = Response::from_string(html)
        .with_header(Header::from_bytes(&b"Content-Type"[..], b"text/html").unwrap())
        .with_header(Header::from_bytes(&b"Cache-Control"[..], b"no-cache").unwrap());

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
