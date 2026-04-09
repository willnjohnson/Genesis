use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use crate::{db, get_db_path};

const DEFAULT_CHUNK_SIZE: usize = 1000;
const DEFAULT_CHUNK_OVERLAP: usize = 100;
const DEFAULT_MAX_CHUNKS: usize = 10;

#[derive(Debug, Serialize, Deserialize)]
pub struct VeniceMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VeniceRequest {
    pub model: String,
    pub messages: Vec<VeniceMessage>,
}

fn chunk_transcript(transcript: &str, chunk_size: usize, overlap: usize, max_chunks: usize) -> Vec<String> {
    if transcript.trim().is_empty() {
        return vec![];
    }

    let lines: Vec<&str> = transcript.lines().collect();
    if lines.is_empty() {
        return vec![];
    }

    let mut chunks = Vec::new();
    let effective_overlap = overlap.min(chunk_size / 2);

    let mut current_chunk = String::new();
    let mut word_count = 0;
    let mut chunk_start_idx = 0;

    for (idx, line) in lines.iter().enumerate() {
        let line_word_count = line.split_whitespace().count();
        
        if line_word_count > chunk_size {
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.clone());
                current_chunk.clear();
                word_count = 0;
            }
            
            let words: Vec<&str> = line.split_whitespace().collect();
            let mut sub_start = 0;
            while sub_start < words.len() {
                let sub_end = (sub_start + chunk_size).min(words.len());
                let sub_chunk: String = words[sub_start..sub_end].join(" ");
                chunks.push(sub_chunk);
                if chunks.len() >= max_chunks {
                    break;
                }
                sub_start = sub_end - effective_overlap.min(sub_end);
            }
            chunk_start_idx = idx + 1;
            word_count = 0;
            continue;
        }

        if word_count + line_word_count > chunk_size && !current_chunk.is_empty() {
            chunks.push(current_chunk.clone());
            
            current_chunk = String::new();
            word_count = 0;
            
            let overlap_lines: Vec<&str> = lines[chunk_start_idx..idx].to_vec();
            for overlap_line in overlap_lines {
                let overlap_words = overlap_line.split_whitespace().count();
                if word_count + overlap_words <= effective_overlap {
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
            chunk_start_idx = idx;
        } else {
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
            word_count += line_word_count;
        }

        if chunks.len() >= max_chunks {
            break;
        }
    }

    if !current_chunk.is_empty() {
        chunks.push(current_chunk);
    }

    chunks
}

async fn call_venice_api(client: &reqwest::Client, api_key: &str, prompt: &str) -> Result<String, String> {
    let request_body = VeniceRequest {
        model: "default".to_string(),
        messages: vec![VeniceMessage {
            role: "user".to_string(),
            content: prompt.to_string(),
        }],
    };

    let response = client
        .post("https://api.venice.ai/api/v1/chat/completions")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Venice API request failed: {}", e))?;

    let status = response.status();
    let error_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Venice API error: {} - {}", status, error_text));
    }

    let result: Value = serde_json::from_str(&error_text)
        .map_err(|e| format!("Failed to parse Venice response: {}", e))?;

    let summary = result["choices"][0]["message"]["content"]
        .as_str()
        .ok_or("Failed to extract summary from Venice response")?
        .to_string();

    Ok(summary)
}

pub async fn summarize_transcript(app: AppHandle, transcript: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    
    let api_key = db::get_setting(&db_path, "venice_api_key")
        .map_err(|e| e.to_string())?
        .ok_or("Venice API key not found. Please set it in Settings.")?;
        
    let prompt_template = db::get_setting(&db_path, "venice_prompt")
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| "Create a synopsis of this video transcript with pretty format.".to_string());

    let word_count = transcript.split_whitespace().count();
    
    if word_count <= DEFAULT_CHUNK_SIZE {
        let prompt = if prompt_template.contains("{}") {
            prompt_template.replace("{}", &transcript)
        } else {
            format!("{}\n\nTranscript:\n{}", prompt_template, transcript)
        };

        let client = reqwest::Client::new();
        return call_venice_api(&client, &api_key, &prompt).await;
    }

    let chunks = chunk_transcript(&transcript, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP, DEFAULT_MAX_CHUNKS);
    
    if chunks.is_empty() {
        return Err("Failed to chunk transcript".to_string());
    }

    let client = reqwest::Client::new();
    let mut chunk_summaries = Vec::new();

    for (i, chunk) in chunks.iter().enumerate() {
        let chunk_prompt = if prompt_template.contains("{}") {
            prompt_template.replace("{}", chunk)
        } else {
            format!("[Part {} of {} of the transcript]\n\n{}\n\n{}", i + 1, chunks.len(), chunk, prompt_template)
        };

        match call_venice_api(&client, &api_key, &chunk_prompt).await {
            Ok(summary) => chunk_summaries.push(summary),
            Err(e) => return Err(format!("Failed to process chunk {}: {}", i + 1, e)),
        }
    }

    if chunk_summaries.len() == 1 {
        return Ok(chunk_summaries.into_iter().next().unwrap());
    }

    let combined = chunk_summaries.join("\n\n---\n\n");
    let combine_prompt = format!(
        "The following are summaries from different segments of a video transcript. Combine them into a single coherent synopsis:\n\n{}\n\nFinal Synopsis:",
        combined
    );

    call_venice_api(&client, &api_key, &combine_prompt).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VeniceImageRequest {
    pub model: String,
    pub prompt: String,
    pub width: u32,
    pub height: u32,
    pub steps: u32,
    pub seed: Option<i64>,
    pub format: String,
    pub safe_mode: bool,
    pub hide_watermark: bool,
    pub embed_exif_metadata: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VeniceImageResponse {
    pub id: String,
    pub images: Vec<String>,
    pub request: serde_json::Value,
    pub timing: serde_json::Value,
}

pub async fn generate_image(app: AppHandle, prompt: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    
    let api_key = db::get_setting(&db_path, "venice_api_key")
        .map_err(|e| e.to_string())?
        .ok_or("Venice API key not found. Please set it in Settings.")?;

    let request_body = VeniceImageRequest {
        model: "nano-banana-pro".to_string(),
        prompt: prompt.clone(),
        width: 1024,
        height: 1024,
        steps: 25,
        seed: None,
        format: "webp".to_string(),
        safe_mode: true,
        hide_watermark: false,
        embed_exif_metadata: false,
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.venice.ai/api/v1/image/generation")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Venice image API request failed: {}", e))?;

    let status = response.status();
    let error_text = response.text().await.unwrap_or_default();

    eprintln!("Raw response (first 500 chars): {}", &error_text[..error_text.len().min(500)]);

    if !status.is_success() {
        return Err(format!("Venice image API error: {} - {}", status, error_text));
    }

    let result: VeniceImageResponse = serde_json::from_str(&error_text)
        .map_err(|e| format!("Failed to parse Venice image response: {}. Response was: {}", e, error_text))?;

    eprintln!("Venice image response: {:?}", result);

    let base64_image = result.images
        .into_iter()
        .next()
        .ok_or_else(|| "No image generated".to_string())?;

    Ok(format!("data:image/webp;base64,{}", base64_image))
}