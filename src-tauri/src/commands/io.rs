use base64::Engine;
use tauri::command;

#[command]
pub fn save_image(path: String, contents_base64: String) -> Result<(), String> {
    let engine = base64::engine::general_purpose::STANDARD;
    let bytes = engine.decode(&contents_base64).map_err(|e| e.to_string())?;
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())
}
