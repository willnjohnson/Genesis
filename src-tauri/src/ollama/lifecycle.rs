use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use crate::{db, get_db_path};

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
