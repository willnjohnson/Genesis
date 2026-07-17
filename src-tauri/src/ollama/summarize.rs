use serde_json::Value;
use tauri::AppHandle;

use crate::{db, get_db_path};
use super::chunking::{ChunkConfig, chunk_transcript, process_chunk, combine_chunk_summaries, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP, DEFAULT_MAX_CHUNKS};
use super::lifecycle::ensure_ollama_running;

const DEFAULT_PROMPT_TEMPLATE: &str = r#"Create a synopsis of this video transcript with pretty format.

Transcript:
{}

Synopsis:"#;

/// Summarize a transcript using Ollama
pub async fn summarize_transcript(app: AppHandle, transcript: String, handle: Option<String>, video_id: Option<String>) -> Result<String, String> {
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
    let mut prompt_template = if prompt_template.trim().is_empty() {
        DEFAULT_PROMPT_TEMPLATE.to_string()
    } else {
        prompt_template
    };

    if let Some(vid) = &video_id {
        if let Ok(Some(video)) = db::get_video_full(&db_path, vid) {
            prompt_template = prompt_template.replace("${title}", &video.1);
            prompt_template = prompt_template.replace("${author}", &video.2);
            prompt_template = prompt_template.replace("${length_seconds}", &video.3.to_string());
            prompt_template = prompt_template.replace("${view_count}", &video.5.to_string());
            prompt_template = prompt_template.replace("${handle}", &video.7);
        }
    }
    if let Some(h) = &handle {
        prompt_template = prompt_template.replace("${handle}", h);
    }

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
