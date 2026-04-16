use tauri::command;
use crate::{get_db_path, db, ollama, venice};

#[command]
pub async fn generate_image(app: tauri::AppHandle, prompt: String) -> Result<String, String> {
    venice::generate_image(app, prompt).await
}

#[command]
pub async fn check_ollama() -> Result<bool, String> {
    ollama::check_ollama().await
}

#[command]
pub async fn check_model_pulled(app: tauri::AppHandle) -> Result<bool, String> {
    ollama::check_model_pulled(app).await
}

#[command]
pub async fn pull_model(app: tauri::AppHandle) -> Result<(), String> {
    ollama::pull_model(app).await
}

#[command]
pub async fn delete_model(app: tauri::AppHandle) -> Result<(), String> {
    ollama::delete_model(app).await
}

#[command]
pub async fn install_ollama(app: tauri::AppHandle) -> Result<(), String> {
    ollama::install_ollama(app).await
}

#[command]
pub fn get_ollama_model(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "ollama_model")
        .map_err(|e| e.to_string())
        .map(|opt| opt.unwrap_or_else(|| "llama3.2".to_string()))
}

#[command]
pub fn set_ollama_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "ollama_model", &model).map_err(|e| e.to_string())
}

#[command]
pub fn get_ollama_prompt(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let default = "Create a synopsis of this video transcript with pretty format.";
    db::get_setting(&db_path, "ollama_prompt")
        .map_err(|e| e.to_string())
        .map(|opt| opt.unwrap_or_else(|| default.to_string()))
}

#[command]
pub fn set_ollama_prompt(app: tauri::AppHandle, prompt: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "ollama_prompt", &prompt).map_err(|e| e.to_string())
}

#[command]
pub fn get_chunk_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "chunk_enabled")
        .map_err(|e| e.to_string())
        .map(|v| v.unwrap_or_else(|| "true".to_string()) == "true")
}

#[command]
pub fn set_chunk_enabled(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "chunk_enabled", &enabled.to_string()).map_err(|e| e.to_string())
}

#[command]
pub fn get_chunk_size(app: tauri::AppHandle) -> Result<usize, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "chunk_size")
        .map_err(|e| e.to_string())
        .and_then(|v| v.and_then(|v| v.parse().ok()).ok_or_else(|| "Invalid chunk size".to_string()))
}

#[command]
pub fn set_chunk_size(app: tauri::AppHandle, size: usize) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "chunk_size", &size.to_string()).map_err(|e| e.to_string())
}

#[command]
pub fn get_max_chunks(app: tauri::AppHandle) -> Result<usize, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "max_chunks")
        .map_err(|e| e.to_string())
        .and_then(|v| v.and_then(|v| v.parse().ok()).ok_or_else(|| "Invalid max chunks".to_string()))
}

#[command]
pub fn set_max_chunks(app: tauri::AppHandle, max: usize) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "max_chunks", &max.to_string()).map_err(|e| e.to_string())
}

// ─── Summarize commands ───────────────────────────────────────────────────────

#[command]
pub async fn summarize_transcript(app: tauri::AppHandle, transcript: String, handle: Option<String>) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let provider = db::get_setting(&db_path, "summarize_provider")
        .unwrap_or(None)
        .unwrap_or_else(|| "local".to_string());

    if provider == "cloud" {
        venice::summarize_transcript(app, transcript, handle).await
    } else {
        ollama::summarize_transcript(app, transcript, handle).await
    }
}

#[command]
pub async fn save_summary(app: tauri::AppHandle, video_id: String, summary: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::save_summary(&db_path, &video_id, &summary).map_err(|e| e.to_string())
}

#[command]
pub async fn save_tags(app: tauri::AppHandle, video_id: String, tags: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::save_tags(&db_path, &video_id, &tags).map_err(|e| e.to_string())
}

#[command]
pub async fn get_summary(app: tauri::AppHandle, video_id: String) -> Result<Option<String>, String> {
    let db_path = get_db_path(&app);
    db::get_summary(&db_path, &video_id).map_err(|e| e.to_string())
}

#[command]
pub async fn get_summarized_count(app: tauri::AppHandle) -> Result<i64, String> {
    let db_path = get_db_path(&app);
    db::get_summarized_count(&db_path).map_err(|e| e.to_string())
}

#[command]
pub async fn get_videos_with_summaries(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&app);
    db::get_videos_with_summaries(&db_path).map_err(|e| e.to_string())
}

#[command]
pub async fn summarize_all_videos(app: tauri::AppHandle) -> Result<i32, String> {
    let db_path = get_db_path(&app);

    let videos_without_summary: Vec<(String, String, Option<String>)> = {
        let conn = rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT video_id, transcript, handle FROM videos WHERE (summary IS NULL OR summary = '') AND transcript IS NOT NULL AND transcript != ''"
        ).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            result.push((
                row.get(0).map_err(|e| e.to_string())?,
                row.get(1).map_err(|e| e.to_string())?,
                row.get(2).unwrap_or(None)
            ));
        }
        result
    };

    if videos_without_summary.is_empty() {
        return Ok(0);
    }

    let provider = db::get_setting(&db_path, "summarize_provider")
        .unwrap_or(None)
        .unwrap_or_else(|| "local".to_string());

    if provider == "local" {
        ollama::ensure_ollama_running().await?;
    }

    let mut count = 0;
    for (video_id, transcript, handle) in videos_without_summary {
        let result = if provider == "cloud" {
            venice::summarize_transcript(app.clone(), transcript, handle).await
        } else {
            ollama::summarize_transcript(app.clone(), transcript, handle).await
        };
        match result {
            Ok(summary) => {
                if db::save_summary(&db_path, &video_id, &summary).is_ok() { count += 1; }
            }
            Err(e) => eprintln!("Failed to summarize {}: {}", video_id, e),
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
    }
    Ok(count)
}

// ─── Venice API key commands ─────────────────────────────────────────────────

#[command]
pub fn get_venice_api_key(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "venice_api_key").map_err(|e| e.to_string())
}

#[command]
pub fn set_venice_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "venice_api_key", &api_key).map_err(|e| e.to_string())
}

#[command]
pub fn remove_venice_api_key(app: tauri::AppHandle) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::delete_setting(&db_path, "venice_api_key").map_err(|e| e.to_string())
}

#[command]
pub fn get_venice_prompt(app: tauri::AppHandle) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let default = "Create a synopsis of this video transcript with pretty format.";
    db::get_setting(&db_path, "venice_prompt")
        .map_err(|e| e.to_string())
        .map(|opt| opt.unwrap_or_else(|| default.to_string()))
}

#[command]
pub fn set_venice_prompt(app: tauri::AppHandle, prompt: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "venice_prompt", &prompt).map_err(|e| e.to_string())
}

#[command]
pub fn get_custom_prompt(app: tauri::AppHandle, handle: String) -> Result<Option<(Option<String>, Option<String>)>, String> {
    let db_path = get_db_path(&app);
    db::get_custom_prompt(&db_path, &handle).map_err(|e| e.to_string())
}

#[command]
pub fn get_all_custom_prompts(app: tauri::AppHandle) -> Result<Vec<(String, Option<String>, Option<String>)>, String> {
    let db_path = get_db_path(&app);
    db::get_all_custom_prompts(&db_path).map_err(|e| e.to_string())
}

#[command]
pub fn set_custom_prompt(app: tauri::AppHandle, handle: String, local_prompt_text: Option<String>, cloud_prompt_text: Option<String>) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_custom_prompt(&db_path, &handle, local_prompt_text.as_deref(), cloud_prompt_text.as_deref()).map_err(|e| e.to_string())
}

#[command]
pub fn delete_custom_prompt(app: tauri::AppHandle, handle: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::delete_custom_prompt(&db_path, &handle).map_err(|e| e.to_string())
}

#[command]
pub fn get_unique_handles(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let db_path = get_db_path(&app);
    db::get_unique_handles(&db_path).map_err(|e| e.to_string())
}
