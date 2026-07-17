use serde_json::Value;

// Default chunk settings
pub(crate) const DEFAULT_CHUNK_SIZE: usize = 1000; // words per chunk
pub(crate) const DEFAULT_CHUNK_OVERLAP: usize = 100; // words overlap between chunks
pub(crate) const DEFAULT_MAX_CHUNKS: usize = 10; // maximum number of chunks to process

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
pub(crate) fn chunk_transcript(transcript: &str, config: &ChunkConfig) -> Vec<String> {
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

            // Rebuild the new chunk starting with trailing lines from the previous chunk (up to
            // `overlap` words), so consecutive chunks share context instead of cutting cleanly.
            current_chunk = String::new();
            word_count = 0;

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
pub(crate) async fn process_chunk(
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
pub(crate) async fn combine_chunk_summaries(
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
