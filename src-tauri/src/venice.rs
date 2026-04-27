use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;
use crate::{db, get_db_path};

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

#[allow(dead_code)]
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
    let mut chunk_start_idx = 0;

    for (idx, line) in lines.iter().enumerate() {
        let line_word_count = line.split_whitespace().count();
        
        if line_word_count > chunk_size {
            if !current_chunk.is_empty() {
                chunks.push(current_chunk.clone());
                current_chunk.clear();
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
            continue;
        }

        let current_word_count = current_chunk.split_whitespace().count();
        if current_word_count + line_word_count > chunk_size && !current_chunk.is_empty() {
            chunks.push(current_chunk.clone());
            
            current_chunk = String::new();
            
            let overlap_lines: Vec<&str> = lines[chunk_start_idx..idx].to_vec();
            for overlap_line in overlap_lines {
                let overlap_words = overlap_line.split_whitespace().count();
                let new_count = current_chunk.split_whitespace().count();
                if new_count + overlap_words <= effective_overlap {
                    if !current_chunk.is_empty() {
                        current_chunk.push('\n');
                    }
                    current_chunk.push_str(overlap_line);
                } else {
                    break;
                }
            }
            
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
            chunk_start_idx = idx;
        } else {
            if !current_chunk.is_empty() {
                current_chunk.push('\n');
            }
            current_chunk.push_str(line);
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
        model: "zai-org-glm-5".to_string(),
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

pub async fn summarize_transcript(app: AppHandle, transcript: String, handle: Option<String>, video_id: Option<String>) -> Result<String, String> {
    let db_path = get_db_path(&app);
    
    let api_key = db::get_setting(&db_path, "venice_api_key")
        .map_err(|e| e.to_string())?
        .ok_or("Venice API key not found. Please set it in Settings.")?;
        
    let mut prompt_template = None;
    if let Some(ref h) = handle {
        if let Ok(Some((_, Some(cloud_prompt)))) = db::get_custom_prompt(&db_path, h) {
            if !cloud_prompt.trim().is_empty() {
                prompt_template = Some(cloud_prompt);
            }
        }
    }
    
    let mut prompt_template = prompt_template.unwrap_or_else(|| {
        db::get_setting(&db_path, "venice_prompt")
            .unwrap_or(None)
            .unwrap_or_else(|| "Create a synopsis of this video transcript with pretty format.".to_string())
    });

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

    let prompt = if prompt_template.contains("{}") {
        prompt_template.replace("{}", &transcript)
    } else {
        format!("{}\n\nTranscript:\n{}", prompt_template, transcript)
    };

    let client = reqwest::Client::new();
    call_venice_api(&client, &api_key, &prompt).await
}

#[derive(Debug, Serialize, Deserialize)]
pub struct VeniceImageRequest {
    pub model: String,
    pub prompt: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub steps: Option<u32>,
    pub seed: Option<i64>,
    pub format: Option<String>,
    pub safe_mode: Option<bool>,
    pub hide_watermark: Option<bool>,
    pub resolution: Option<String>,
    pub return_binary: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct VeniceImageResponse {
    pub images: Option<Vec<String>>,
    pub data: Option<Vec<VeniceImageData>>,
}

#[derive(Debug, Deserialize)]
pub struct VeniceImageData {
    #[serde(rename = "b64_json")]
    pub b64_json: Option<String>,
    pub url: Option<String>,
}

pub async fn generate_image(app: AppHandle, prompt: String) -> Result<String, String> {
    let db_path = get_db_path(&app);
    
    let api_key = db::get_setting(&db_path, "venice_api_key")
        .map_err(|e| e.to_string())?
        .ok_or("Venice API key not found. Please set it in Settings.")?;

    let request_body = VeniceImageRequest {
        model: "nano-banana-pro".to_string(),
        prompt,
        width: Some(1024),
        height: Some(1024),
        steps: Some(25),
        seed: Some(0),
        format: Some("png".to_string()),
        safe_mode: Some(false),
        hide_watermark: Some(true),
        resolution: Some("1K".to_string()),
        return_binary: Some(false),
    };

    let client = reqwest::Client::new();
    let response = client
        .post("https://api.venice.ai/api/v1/image/generate")
        .header("Authorization", format!("Bearer {}", api_key))
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| format!("Venice image API request failed: {}", e))?;

    let status = response.status();
    let error_text = response.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(format!("Venice image API error: {} - {}", status, error_text));
    }

    let result: VeniceImageResponse = serde_json::from_str(&error_text)
        .map_err(|e| format!("Failed to parse Venice image response: {}. Response was: {}", e, error_text))?;

    // Try new format first (images array)
    if let Some(images) = result.images {
        if let Some(base64_image) = images.into_iter().next() {
            return Ok(format!("data:image/png;base64,{}", base64_image));
        }
    }

    // Try OpenAI-compatible format (data array with b64_json)
    if let Some(data) = result.data {
        if let Some(first) = data.into_iter().next() {
            if let Some(b64) = first.b64_json {
                return Ok(format!("data:image/png;base64,{}", b64));
            }
            if let Some(url) = first.url {
                return Ok(url);
            }
        }
    }

    Err("No image generated in response".to_string())
}