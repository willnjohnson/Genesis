use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::{db, get_db_path};

// Default chunk settings
const DEFAULT_CHUNK_SIZE: usize = 1000; // words per chunk
const DEFAULT_CHUNK_OVERLAP: usize = 100; // words overlap between chunks
const DEFAULT_MAX_CHUNKS: usize = 10; // maximum number of chunks to process

/// Chunk configuration settings
#[derive(Debug, Clone)]
pub struct ChunkConfig {
    pub enabled: bool,
    pub chunk_size: usize,
    pub chunk_overlap: usize,
    pub max_chunks: usize,
}

impl Default for ChunkConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            chunk_size: DEFAULT_CHUNK_SIZE,
            chunk_overlap: DEFAULT_CHUNK_OVERLAP,
            max_chunks: DEFAULT_MAX_CHUNKS,
        }
    }
}

/// Split transcript into chunks based on word count while preserving newlines
fn chunk_transcript(transcript: &str, config: &ChunkConfig) -> Vec<String> {
    if transcript.trim().is_empty() {
        return vec![];
    }

    // Split by newlines to preserve line structure
    let lines: Vec<&str> = transcript.lines().collect();
    if lines.is_empty() {
        return vec![];
    }

    let mut chunks = Vec::new();
    let chunk_size = config.chunk_size;
    let overlap = config.chunk_overlap.min(chunk_size / 2);

    let mut current_chunk = String::new();
    let mut word_count = 0;
    let mut chunk_start_word = 0;

    for (idx, line) in lines.iter().enumerate() {
        let line_word_count = line.split_whitespace().count();
        
        // If a single line exceeds chunk size, we need to handle it
        if line_word_count > chunk_size {
            // First, save current chunk if not empty
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.clone());
                current_chunk.clear();
            }
            
            // Split this long line into sub-chunks
            let words: Vec<&str> = line.split_whitespace().collect();
            let mut sub_start = 0;
            while sub_start < words.len() {
                let sub_end = (sub_start + chunk_size).min(words.len());
                let sub_chunk: String = words[sub_start..sub_end].join(" ");
                chunks.push(sub_chunk);
                sub_start = sub_end - overlap.min(sub_end);
            }
            chunk_start_word = idx + 1;
            word_count = 0;
            continue;
        }

        // Check if adding this line would exceed chunk size
        if word_count + line_word_count > chunk_size && !current_chunk.is_empty() {
            chunks.push(current_chunk.clone());
            
            // For overlap, we need to be more sophisticated
            // Start from beginning to get proper overlap
            current_chunk = String::new();
            word_count = 0;
            
            // Rebuild chunk with overlap
            let overlap_lines: Vec<&str> = lines[chunk_start_word..idx].to_vec();
            for overlap_line in overlap_lines {
                let overlap_words = overlap_line.split_whitespace().count();
                if word_count + overlap_words <= overlap {
                    if !current_chunk.is_empty() {
                        current_chunk.push('\n');
                    }
                    current_chunk.push_str(overlap_line);
                    word_count += overlap_words;
                } else {
                    break;
                }
            }
            
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
            word_count += line_word_count;
            chunk_start_word = idx;
        } else {
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
            word_count += line_word_count;
        }

        // Check max chunks
        if chunks.len() >= config.max_chunks {
            break;
        }
    }

    // Push remaining chunk
    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }

    chunks
}

/// Process a single chunk through the AI model
async fn process_chunk(
    client: &reqwest::Client,
    model: &str,
    chunk: &str,
    prompt_template: &str,
    ollama_url: &str,
) -> Result<String, String> {
    // Use the custom prompt template for chunk processing
    let prompt = if prompt_template.contains("{}") {
        prompt_template.replace("{}", chunk)
    } else {
        format!("Transcript segment:\n{}\n\n{}", chunk, prompt_template)
    };
    
    let request_body = serde_json::json!({
        "model": model,
        "prompt": prompt,
        "stream": false,
        "keep_alive": 300,
        "options": {
            "temperature": 0.3,
            "num_predict": 512,
            "gpu_layers": 0
        }
    });
    
    let response = client
        .post(ollama_url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to process chunk: {}", e))?;
    
    let status = response.status();
    
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Chunk processing failed: {} - {}", status, error_text));
    }
    
    let result: Value = response.json().await
        .map_err(|e| format!("Failed to parse chunk response: {}", e))?;
    
    let response_text = result["response"].as_str()
        .unwrap_or("")
        .trim()
        .to_string();
    
    Ok(response_text)
}

/// Combine multiple chunk summaries into a final summary
async fn combine_chunk_summaries(
    client: &reqwest::Client,
    model: &str,
    chunk_summaries: Vec<String>,
    _prompt_template: &str,
    ollama_url: &str,
) -> Result<String, String> {
    if chunk_summaries.is_empty() {
        return Ok(String::new());
    }
    
    if chunk_summaries.len() == 1 {
        return Ok(chunk_summaries.into_iter().next().unwrap_or_default());
    }
    
    // Join all chunk summaries
    let combined_text = chunk_summaries.join("\n\n---\n\n");
    
    // Create a combination prompt
    let combine_prompt = format!(
        "The following are summaries from different segments of a video transcript. Combine them into a single coherent synopsis:\n\n{}\n\nFinal Synopsis:",
        combined_text
    );
    
    let request_body = serde_json::json!({
        "model": model,
        "prompt": combine_prompt,
        "stream": false,
        "keep_alive": 300,
        "options": {
            "temperature": 0.3,
            "num_predict": 768,
            "gpu_layers": 0
        }
    });
    
    let response = client
        .post(ollama_url)
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Failed to combine summaries: {}", e))?;
    
    let status = response.status();
    
    if !status.is_success() {
        let error_text = response.text().await.unwrap_or_default();
        return Err(format!("Combine failed: {} - {}", status, error_text));
    }
    
    let result: Value = response.json().await
        .map_err(|e| format!("Failed to parse combine response: {}", e))?;
    
    let final_summary = result["response"].as_str()
        .unwrap_or("Failed to generate summary")
        .trim()
        .to_string();
    
    Ok(final_summary)
}

const DEFAULT_PROMPT_TEMPLATE: &str = r#"Create a synopsis of this video transcript with pretty format.

Transcript:
{}

Synopsis:"#;



/// Check if Ollama is running
pub async fn check_ollama() -> Result<bool, String> {
    println!("Checking Ollama status...");
    let client = reqwest::Client::new();
    let response = client.get("http://localhost:11434/api/tags").send().await;
    let is_ok = response.is_ok();
    println!("Ollama running: {}", is_ok);
    Ok(is_ok)
}

/// Check if the specific model is pulled
pub async fn check_model_pulled(app: AppHandle) -> Result<bool, String> {
    let db_path = get_db_path(&app);
    let model_setting = db::get_setting(&db_path, "ollama_model")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "llama3.2".to_string());
    
    let client = reqwest::Client::new();
    let tags_resp = client.get("http://localhost:11434/api/tags").send().await;
    
    if let Ok(resp) = tags_resp {
        if let Ok(json) = resp.json::<Value>().await {
            if let Some(models) = json["models"].as_array() {
                let model_exists = models.iter().any(|m| {
                    let name = m["name"].as_str().unwrap_or("");
                    name.starts_with(&model_setting) || name.starts_with(&format!("{}:", model_setting))
                });
                return Ok(model_exists);
            }
        }
    }
    
    Ok(false)
}

/// Pull a model from Ollama
pub async fn pull_model(app: AppHandle) -> Result<(), String> {
    // Get the selected model from settings
    let db_path = get_db_path(&app);
    let model_setting = db::get_setting(&db_path, "ollama_model")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "llama3.2".to_string());
    
    println!("Starting model pull: {}", model_setting);
    let client = reqwest::Client::new();
    let window = app.get_webview_window("main").ok_or("Could not find main window")?;
    
    // Check if model already exists
    let tags_resp = client.get("http://localhost:11434/api/tags").send().await;
    if let Ok(resp) = tags_resp {
        if let Ok(json) = resp.json::<Value>().await {
            if let Some(models) = json["models"].as_array() {
                // Check for any variant of the selected model
                let model_exists = models.iter().any(|m| {
                    let name = m["name"].as_str().unwrap_or("");
                    name.starts_with(&model_setting) || name.starts_with(&format!("{}:", model_setting))
                });
                if model_exists {
                    println!("Model {} already exists, skipping pull.", model_setting);
                    window.emit("plugin_progress", &format!("Model {} already installed.", model_setting)).map_err(|e: tauri::Error| e.to_string())?;
                    return Ok(());
                }
            }
        }
    }

    window.emit("plugin_progress", &format!("Pulling {} (this may take a while)...", model_setting)).map_err(|e: tauri::Error| e.to_string())?;

    // Try pulling with streaming to see more progress
    let response = client
        .post("http://localhost:11434/api/pull")
        .json(&serde_json::json!({ 
            "name": model_setting, 
            "stream": true 
        }))
        .send()
        .await
        .map_err(|e| {
            println!("Error connecting to Ollama for pull: {}", e);
            format!("Failed to connect to Ollama: {}", e)
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_text = response.text().await.unwrap_or_default();
        println!("Ollama pull error status: {}, error: {}", status, error_text);
        return Err(format!("Ollama pull error: {} - {}", status, error_text));
    }

    // Read streaming response to keep connection alive
    let _ = response.text().await;
    
    println!("Model pull completed.");
    window.emit("plugin_progress", "Finished pulling model.").map_err(|e: tauri::Error| e.to_string())?;
    Ok(())
}

/// Delete model from Ollama
pub async fn delete_model(app: AppHandle) -> Result<(), String> {
    // Get the selected model from settings
    let db_path = get_db_path(&app);
    let model_setting = db::get_setting(&db_path, "ollama_model")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "llama3.2".to_string());
    
    println!("Starting model delete: {}", model_setting);
    let client = reqwest::Client::new();
    
    // First, get the list of all models to find any matching variants
    let tags_resp = client.get("http://localhost:11434/api/tags").send().await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    
    let json: Value = tags_resp.json().await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;
    
    let models = json["models"].as_array()
        .ok_or("Invalid response from Ollama: no models array")?;
    
    // Find any models that start with the selected model name
    let matching_models: Vec<String> = models.iter()
        .filter_map(|m| m["name"].as_str())
        .filter(|name| name.starts_with(&model_setting))
        .map(|s| s.to_string())
        .collect();
    
    if matching_models.is_empty() {
        println!("No {} models found in Ollama, nothing to delete.", model_setting);
        return Ok(());
    }
    
    println!("Found {} models to delete: {:?}", model_setting, matching_models);
    
    // Delete each matching model
    for model_name in matching_models {
        println!("Deleting model: {}", model_name);
        let response = client
            .delete("http://localhost:11434/api/delete")
            .json(&serde_json::json!({ "name": model_name }))
            .send()
            .await
            .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;

        if response.status().is_success() {
            println!("Model {} deleted successfully.", model_name);
        } else if response.status().as_u16() == 404 {
            println!("Model {} not found.", model_name);
        } else {
            return Err(format!("Ollama delete error for {}: {}", model_name, response.status()));
        }
    }
    
    println!("Model deletion complete.");
    Ok(())
}

/// Try to ensure Ollama is running, start it if not
pub async fn ensure_ollama_running() -> Result<(), String> {
    let client = reqwest::Client::new();
    if client.get("http://localhost:11434/api/tags").send().await.is_ok() {
        return Ok(());
    }

    println!("Ollama not running, attempting to start headlessly...");
    
    #[cfg(target_os = "windows")]
    {
        // Try multiple possible installation paths
        let mut possible_paths = vec![];
        
        // Option 1: User installation (LOCALAPPDATA)
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let user_path = std::path::Path::new(&local_app_data).join("Ollama").join("ollama.exe");
            possible_paths.push(user_path);
        }
        
        // Option 2: System-wide installation (Program Files)
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let system_path = std::path::Path::new(&program_files).join("Ollama").join("ollama.exe");
        possible_paths.push(system_path);
        
        // Option 3: Program Files (x86) for 32-bit installations
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
        let x86_path = std::path::Path::new(&program_files_x86).join("Ollama").join("ollama.exe");
        possible_paths.push(x86_path);
        
        for ollama_bin_path in &possible_paths {
            println!("Checking for Ollama CLI at: {:?}", ollama_bin_path);
            if ollama_bin_path.exists() {
                println!("Found Ollama at: {:?}", ollama_bin_path);
                let spawn_result = std::process::Command::new(ollama_bin_path)
                    .arg("serve")
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn();
                
                match spawn_result {
                    Ok(_child) => {
                        println!("Ollama process spawned, waiting for service...");
                        // Poll for up to 10 seconds
                        for _ in 0..20 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            if client.get("http://localhost:11434/api/tags").send().await.is_ok() {
                                println!("Ollama service started successfully.");
                                return Ok(());
                            }
                        }
                    }
                    Err(e) => {
                        println!("Failed to spawn Ollama: {}", e);
                        continue;
                    }
                }
            }
        }
        
        // Try to find ollama in PATH using where command
        println!("Trying to find ollama in PATH...");
        let where_output = std::process::Command::new("where")
            .arg("ollama.exe")
            .output();
        
        if let Ok(output) = where_output {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                println!("Found ollama in PATH: {}", path_str);
                // Try the first path found
                if let Some(first_line) = path_str.lines().next() {
                    let path = std::path::Path::new(first_line.trim());
                    if path.exists() {
                        let spawn_result = std::process::Command::new(path)
                            .arg("serve")
                            .creation_flags(0x08000000)
                            .spawn();
                        
                        match spawn_result {
                            Ok(_child) => {
                                println!("Ollama process spawned from PATH, waiting for service...");
                                for _ in 0..20 {
                                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                                    if client.get("http://localhost:11434/api/tags").send().await.is_ok() {
                                        println!("Ollama service started successfully.");
                                        return Ok(());
                                    }
                                }
                            }
                            Err(e) => {
                                println!("Failed to spawn Ollama from PATH: {}", e);
                            }
                        }
                    }
                }
            }
        }
    }

    Err("Ollama is not running and could not be started automatically. Please ensure it is installed.".to_string())
}

/// Install Ollama on the current system
pub async fn install_ollama(app: AppHandle) -> Result<(), String> {
    println!("Starting Ollama installation...");
    let window = app.get_webview_window("main").ok_or("Could not find main window")?;
    
    window.emit("plugin_progress", "Downloading Ollama installer...").map_err(|e: tauri::Error| e.to_string())?;

    let os = std::env::consts::OS;
    let arch = std::env::consts::ARCH;
    println!("Detected OS: {}, architecture: {}", os, arch);

    // Handle Linux installation using the official install script
    #[cfg(target_os = "linux")]
    {
        println!("Detected Linux. Running official Ollama install script...");
        window.emit("plugin_progress", "Running Ollama install script (may require sudo)...").map_err(|e: tauri::Error| e.to_string())?;

        // Run the official install script: curl -fsSL https://ollama.com/install.sh | sh
        let output = tokio::process::Command::new("sh")
            .arg("-c")
            .arg("curl -fsSL https://ollama.com/install.sh | sh")
            .output()
            .await
            .map_err(|e| {
                let msg = format!("Failed to run install script: {}", e);
                println!("{}", msg);
                msg
            })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        println!("Install script stdout: {}", stdout);
        println!("Install script stderr: {}", stderr);

        if !output.status.success() {
            let msg = format!("Install script failed with code: {:?}. stderr: {}", output.status.code(), stderr);
            println!("{}", msg);
            window.emit("plugin_progress", msg.clone()).map_err(|e: tauri::Error| e.to_string())?;
            return Err(msg);
        }

        println!("Install script completed successfully. Starting Ollama service...");
        window.emit("plugin_progress", "Starting Ollama service...").map_err(|e: tauri::Error| e.to_string())?;

        // Start the systemd service (the install script sets this up)
        let start_output = tokio::process::Command::new("sudo")
            .args(&["systemctl", "start", "ollama"])
            .output()
            .await
            .map_err(|e| {
                let msg = format!("Failed to start ollama service: {}", e);
                println!("{}", msg);
                msg
            })?;

        if !start_output.status.success() {
            let stderr = String::from_utf8_lossy(&start_output.stderr);
            let msg = format!("Failed to start ollama service: {}", stderr);
            println!("{}", msg);
            window.emit("plugin_progress", msg.clone()).map_err(|e: tauri::Error| e.to_string())?;
            return Err(msg);
        }

        // Poll the health endpoint until Ollama is ready (up to 30 seconds)
        println!("Waiting for Ollama API to be ready...");
        window.emit("plugin_progress", "Waiting for Ollama API to be ready...").map_err(|e: tauri::Error| e.to_string())?;
        
        let client = reqwest::Client::new();
        let mut ready = false;
        for attempt in 0..30 {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            match client.get("http://127.0.0.1:11434/api/ping").send().await {
                Ok(resp) if resp.status().is_success() => {
                    println!("Ollama API is ready!");
                    ready = true;
                    break;
                }
                _ => {
                    if attempt % 5 == 0 {
                        println!("Waiting for Ollama (attempt {})", attempt);
                    }
                }
            }
        }

        if !ready {
            let msg = "Ollama service started but API is not responding after 30 seconds. Please check the service status: sudo systemctl status ollama".to_string();
            println!("{}", msg);
            window.emit("plugin_progress", msg.clone()).map_err(|e: tauri::Error| e.to_string())?;
            return Err(msg);
        }

        println!("Ollama installation and startup completed successfully!");
        window.emit("plugin_progress", "Ollama installed and ready!".to_string()).map_err(|e: tauri::Error| e.to_string())?;
        return Ok(());
    }

    // Handle macOS and other platforms
    #[cfg(target_os = "macos")]
    {
        println!("Detected macOS. macOS installation not yet implemented; please visit https://ollama.com/download");
        let msg = "macOS automatic installation not yet implemented. Please install Ollama from https://ollama.com/download".to_string();
        window.emit("plugin_progress", msg.clone()).map_err(|e: tauri::Error| e.to_string())?;
        return Err(msg);
    }

    // Windows installation
    let installer_url = if arch == "aarch64" {
        "https://ollama.com/download/OllamaSetup-arm64.exe"
    } else {
        "https://ollama.com/download/OllamaSetup.exe"
    };

    println!("Downloading from: {}", installer_url);
    
    let client = reqwest::Client::new();
    let response = client.get(installer_url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .send().await.map_err(|e| {
        println!("Download failed: {}", e);
        e.to_string()
    })?;
    
    let bytes = response.bytes().await.map_err(|e| {
        println!("Failed to get bytes: {}", e);
        e.to_string()
    })?;

    println!("Downloaded {} bytes.", bytes.len());
    if bytes.len() < 1000000 {
        return Err("Downloaded file is too small. It might be corrupted or a 404 page.".to_string());
    }

    let temp_dir = std::env::temp_dir();
    let installer_path = temp_dir.join("OllamaSetup.exe");
    
    println!("Saving installer to: {:?}", installer_path);
    std::fs::write(&installer_path, bytes).map_err(|e| {
        println!("Failed to write installer: {}", e);
        e.to_string()
    })?;
    
    window.emit("plugin_progress", "Installing Ollama (silently)...").map_err(|e: tauri::Error| e.to_string())?;
    println!("Running installer silently...");

    #[cfg(target_os = "windows")]
    {
        let status = tokio::process::Command::new(&installer_path)
            .args(&["/SP-", "/VERYSILENT", "/NORESTART"])
            .status()
            .await
            .map_err(|e| {
                println!("Installer execution failed: {}", e);
                format!("Failed to run installer: {}", e)
            })?;

        if !status.success() {
            println!("Installer failed with code: {:?}", status.code());
            return Err(format!("Installer exited with error code: {:?}", status.code()));
        }

        println!("Installer finished successfully. Attempting to start Ollama...");

        // Try multiple possible installation paths
        let mut possible_paths = vec![];
        
        // Option 1: User installation (LOCALAPPDATA)
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let user_path = std::path::Path::new(&local_app_data).join("Ollama").join("ollama.exe");
            possible_paths.push(user_path);
        }
        
        // Option 2: System-wide installation (Program Files)
        let program_files = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".to_string());
        let system_path = std::path::Path::new(&program_files).join("Ollama").join("ollama.exe");
        possible_paths.push(system_path);
        
        // Option 3: Program Files (x86) for 32-bit installations
        let program_files_x86 = std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".to_string());
        let x86_path = std::path::Path::new(&program_files_x86).join("Ollama").join("ollama.exe");
        possible_paths.push(x86_path);
        
        for ollama_bin_path in &possible_paths {
            println!("Checking for Ollama CLI at: {:?}", ollama_bin_path);
            if ollama_bin_path.exists() {
                window.emit("plugin_progress", "Starting Ollama service...").map_err(|e: tauri::Error| e.to_string())?;
                println!("Launching Ollama service (headless)...");
                // Launch 'ollama serve' in background
                let spawn_result = std::process::Command::new(ollama_bin_path)
                    .arg("serve")
                    .creation_flags(0x08000000) // CREATE_NO_WINDOW
                    .spawn();
                
                match spawn_result {
                    Ok(_child) => {
                        println!("Ollama process spawned, waiting for service...");
                        // Wait for service to be ready
                        for _ in 0..20 {
                            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                            let client = reqwest::Client::new();
                            if client.get("http://localhost:11434/api/tags").send().await.is_ok() {
                                println!("Ollama service started successfully.");
                                return Ok(());
                            }
                        }
                    }
                    Err(e) => {
                        println!("Failed to spawn Ollama: {}", e);
                        continue;
                    }
                }
            }
        }
    }
    
    Ok(())
}

/// Summarize a transcript using Ollama
pub async fn summarize_transcript(app: AppHandle, transcript: String, handle: Option<String>) -> Result<String, String> {
    ensure_ollama_running().await?;
    
    // Get settings from database
    let db_path = get_db_path(&app);
    let model_setting = db::get_setting(&db_path, "ollama_model")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "llama3.2".to_string());
        
    let mut prompt_template_opt = None;
    if let Some(ref h) = handle {
        if let Ok(Some((Some(local_prompt), _))) = db::get_custom_prompt(&db_path, h) {
            if !local_prompt.trim().is_empty() {
                prompt_template_opt = Some(local_prompt);
            }
        }
    }
    
    let prompt_template = prompt_template_opt.unwrap_or_else(|| {
        db::get_setting(&db_path, "ollama_prompt")
            .unwrap_or(None)
            .unwrap_or_else(|| DEFAULT_PROMPT_TEMPLATE.to_string())
    });
    
    // Get chunking settings
    let chunk_enabled = db::get_setting(&db_path, "chunk_enabled")
        .map_err(|e| e.to_string())?
        .map(|v| v == "true")
        .unwrap_or(true);
    let chunk_size = db::get_setting(&db_path, "chunk_size")
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_CHUNK_SIZE);
    let chunk_overlap = db::get_setting(&db_path, "chunk_overlap")
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_CHUNK_OVERLAP);
    let max_chunks = db::get_setting(&db_path, "max_chunks")
        .map_err(|e| e.to_string())?
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_CHUNKS);
    
    let chunk_config = ChunkConfig {
        enabled: chunk_enabled,
        chunk_size,
        chunk_overlap,
        max_chunks,
    };
    
    // Use default prompt if the saved prompt is empty
    let prompt_template = if prompt_template.trim().is_empty() {
        DEFAULT_PROMPT_TEMPLATE.to_string()
    } else {
        prompt_template
    };
    
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))  // 2 minute timeout for CPU-based generation
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {}", e))?;
    
    let ollama_url = "http://localhost:11434/api/generate";
    
    // First, get available models
    let tags_response = client
        .get("http://localhost:11434/api/tags")
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Ollama: {}", e))?;
    
    if !tags_response.status().is_success() {
        return Err(format!("Failed to get model list: {}", tags_response.status()));
    }
    
    let tags_result: Value = tags_response.json().await
        .map_err(|e| format!("Failed to parse model list: {}", e))?;
    
    println!("Available models: {:?}", tags_result);
    
    // Get selected model from settings
    let selected_model = model_setting.clone();
    println!("Selected model from settings: {}", selected_model);
    
    // Check if the selected model exists, otherwise use first available
    let models = tags_result["models"].as_array();
    let model_name = match models {
        Some(arr) if !arr.is_empty() => {
            // First check if the selected model exists (exact match or partial match)
            let selected_exists = arr.iter().any(|m| {
                let name = m["name"].as_str().unwrap_or("");
                // Check for exact match or if the model name contains the selected model
                name == selected_model 
                    || name.starts_with(&selected_model)
                    || name.starts_with(&format!("{}:", selected_model))
                    || selected_model.starts_with(name.split(':').next().unwrap_or(""))
            });
            
            println!("Selected model exists in Ollama: {}", selected_exists);
            
            if selected_exists {
                // Use the selected model (find exact name with tag)
                let found = arr.iter()
                    .find(|m| {
                        let name = m["name"].as_str().unwrap_or("");
                        name == selected_model 
                            || name.starts_with(&selected_model)
                            || name.starts_with(&format!("{}:", selected_model))
                            || selected_model.starts_with(name.split(':').next().unwrap_or(""))
                    })
                    .and_then(|m| m["name"].as_str());
                
                println!("Using selected model: {:?}", found);
                found.unwrap_or("llama3.2")
            } else {
                // Use the first available model
                let first_model = arr[0].get("name").and_then(|n| n.as_str()).unwrap_or("llama3.2");
                println!("Selected model not found, using first available: {}", first_model);
                first_model
            }
        }
        _ => {
            // No models installed - return helpful error
            return Err("No Ollama models installed. Please go to Settings > Summarize Transcripts > Install to download a model.".to_string());
        }
    };
    
    // Extract just the model name (without tags like :latest)
    let model = model_name.split(':').next().unwrap_or(&model_setting);
    println!("Using model: {}", model);
    
    // Estimate word count for logging
    let word_count = transcript.split_whitespace().count();
    println!("Transcript word count: {}", word_count);
    
    // Check if we need chunking
    if chunk_config.enabled && word_count > chunk_config.chunk_size {
        println!("Transcript exceeds chunk size, using chunking pipeline");
        return summarize_with_chunking(&client, model, &transcript, &prompt_template, ollama_url, &chunk_config).await;
    }
    
    // Original single-pass processing for short transcripts
    summarize_single_pass(&client, model, &transcript, &prompt_template, ollama_url).await
}

/// Summarize using chunking pipeline for long transcripts
async fn summarize_with_chunking(
    client: &reqwest::Client,
    model: &str,
    transcript: &str,
    prompt_template: &str,
    ollama_url: &str,
    config: &ChunkConfig,
) -> Result<String, String> {
    // Split transcript into chunks
    let chunks = chunk_transcript(transcript, config);
    println!("Split transcript into {} chunks", chunks.len());
    
    if chunks.is_empty() {
        return Err("Transcript is empty".to_string());
    }
    
    // Process each chunk
    let mut chunk_summaries = Vec::new();
    for (i, chunk) in chunks.iter().enumerate() {
        println!("Processing chunk {}/{} ({} words)", i + 1, chunks.len(), chunk.split_whitespace().count());
        
        // Add context about which part of the transcript this is
        let chunk_prompt = format!(
            "[This is part {} of {} of the transcript. Create a detailed summary of this segment.]
\n{}",
            i + 1,
            chunks.len(),
            chunk
        );
        
        match process_chunk(client, model, &chunk_prompt, prompt_template, ollama_url).await {
            Ok(summary) => {
                println!("Chunk {} summary: {} chars", i + 1, summary.len());
                chunk_summaries.push(summary);
            }
            Err(e) => {
                println!("Failed to process chunk {}: {}", i + 1, e);
                return Err(format!("Failed to process chunk {}: {}", i + 1, e));
            }
        }
    }
    
    // Combine all chunk summaries
    println!("Combining {} chunk summaries", chunk_summaries.len());
    combine_chunk_summaries(client, model, chunk_summaries, prompt_template, ollama_url).await
}

/// Original single-pass summarization for shorter transcripts
async fn summarize_single_pass(
    client: &reqwest::Client,
    model: &str,
    transcript: &str,
    prompt_template: &str,
    ollama_url: &str,
) -> Result<String, String> {
    
    // Retry logic for model loading
    let mut last_error = String::new();
    for attempt in 0..3 {
        if attempt > 0 {
            println!("Retry attempt {} for model {}", attempt, model);
            tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        }
        
        // Use the custom prompt template
        // If the prompt contains {}, replace it with transcript; otherwise prepend transcript automatically
        let prompt = if prompt_template.contains("{}") {
            prompt_template.replace("{}", &transcript)
        } else {
            format!("Transcript:\n{}\n\n{}", transcript, prompt_template)
        };
        
        let request_body = serde_json::json!({
            "model": model,
            "prompt": prompt,
            "stream": false,
            "keep_alive": 300,  // Keep model loaded for 5 minutes (300 seconds)
            "options": {
                "temperature": 0.3,
                "num_predict": 512,
                "gpu_layers": 0
            }
        });
        
        let response = match client
            .post(ollama_url)
            .json(&request_body)
            .send()
            .await {
                Ok(r) => r,
                Err(e) => {
                    last_error = format!("Connection error: {}", e);
                    println!("Request failed: {}", last_error);
                    continue;
                }
            };
        
        let status = response.status();
        if !status.is_success() {
            let error_text = response.text().await.unwrap_or_default();
            last_error = format!("{} - {}", status, error_text);
            println!("HTTP error: {}", last_error);
            continue;
        }
        
        let result: Value = match response.json().await {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("Parse error: {}", e);
                println!("Parse error: {}", last_error);
                continue;
            }
        };
        
        let summary = result["response"].as_str()
            .unwrap_or("Failed to generate summary")
            .trim()
            .to_string();
        
        println!("Summary generated successfully: {} chars", summary.len());
        return Ok(summary);
    }
    
    Err(format!("Ollama failed to generate summary after multiple attempts: {}", last_error))
}
