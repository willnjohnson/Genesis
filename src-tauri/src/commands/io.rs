use base64::Engine;
use tauri::command;

#[command]
pub fn save_image(path: String, mut contents_base64: String) -> Result<(), String> {
    // Robustness: strip any data uri prefix if it somehow got through
    if let Some(comma_idx) = contents_base64.find(',') {
        contents_base64 = contents_base64[comma_idx + 1..].to_string();
    }
    
    // Trim whitespace
    let trimmed = contents_base64.trim();
    
    let engine = base64::engine::general_purpose::STANDARD;
    
    // Try standard first, then fall back to URL-safe if needed
    let bytes = engine.decode(trimmed).or_else(|_| {
        let url_engine = base64::engine::general_purpose::URL_SAFE;
        url_engine.decode(trimmed)
    }).map_err(|e| format!("Base64 decode failed: {}", e))?;
    
    std::fs::write(&path, &bytes).map_err(|e| format!("File write failed at {}: {}", path, e))
}
