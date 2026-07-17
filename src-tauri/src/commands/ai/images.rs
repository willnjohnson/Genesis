use tauri::command;
use crate::{get_db_path, db};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct PixabayHit {
    pub id: i64,
    #[serde(rename = "largeImageURL")]
    pub large_image_url: String,
    #[serde(rename = "webformatURL")]
    pub webformat_url: String,
    #[serde(rename = "imageWidth")]
    pub image_width: i64,
    #[serde(rename = "imageHeight")]
    pub image_height: i64,
    pub tags: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct PixabayResponse {
    pub total: i64,
    #[serde(rename = "totalHits")]
    pub total_hits: i64,
    pub hits: Vec<PixabayHit>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PixabayImage {
    pub id: i64,
    pub url: String,
    pub thumbnail: String,
    pub width: i64,
    pub height: i64,
    pub tags: String,
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[command]
pub async fn search_pixabay(app: tauri::AppHandle, query: String) -> Result<Vec<PixabayImage>, String> {
    let db_path = get_db_path(&app);

    let api_key = match db::get_setting(&db_path, "pixabay_api_key") {
        Ok(Some(key)) => key,
        _ => return Err("Pixabay API key not set. Please add your API key in Settings.".to_string()),
    };

    let url = format!(
        "https://pixabay.com/api/?key={}&q={}&image_type=photo&per_page=20&safesearch=true",
        api_key,
        urlencoding::encode(&query)
    );

    let client = reqwest::Client::new();
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Pixabay API error: {}", response.status()));
    }

    let pixabay_response: PixabayResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Pixabay response: {}", e))?;

    let images: Vec<PixabayImage> = pixabay_response.hits.into_iter()
        .map(|hit| PixabayImage {
            id: hit.id,
            url: hit.large_image_url,
            thumbnail: hit.webformat_url,
            width: hit.image_width,
            height: hit.image_height,
            tags: hit.tags,
        })
        .collect();

    Ok(images)
}

#[command]
pub async fn upload_to_imgur(image_url: String) -> Result<String, String> {
    let client = reqwest::Client::new();

    let base64_data = if image_url.starts_with("data:") {
        image_url.split(',').nth(1).ok_or("Invalid data URL format")?.to_string()
    } else {
        let response = client.get(&image_url)
            .send()
            .await
            .map_err(|e| format!("Failed to fetch image: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Failed to fetch image: {}", response.status()));
        }

        let bytes = response.bytes()
            .await
            .map_err(|e| format!("Failed to read image: {}", e))?;

        base64_encode(&bytes)
    };

    let imgur_client_id = "546c25a59c58ad7"; // Default client ID from Photosynthesis

    let upload_response = client.post("https://api.imgur.com/3/image")
        .header("Authorization", format!("Client-ID {}", imgur_client_id))
        .form(&[("image", &base64_data), ("type", &"base64".to_string())])
        .send()
        .await
        .map_err(|e| format!("Imgur upload failed: {}", e))?;

    if !upload_response.status().is_success() {
        let status = upload_response.status();
        let error_text = upload_response.text().await.unwrap_or_default();
        return Err(format!("Imgur upload failed: {} - {}", status, error_text));
    }

    let response_text = upload_response.text().await.unwrap_or_default();

    #[derive(Deserialize)]
    struct ImgurResponse {
        data: ImgurData,
    }

    #[derive(Deserialize)]
    struct ImgurData {
        link: String,
    }

    let result: ImgurResponse = serde_json::from_str(&response_text)
        .map_err(|e| format!("Failed to parse Imgur response: {}", e))?;

    Ok(result.data.link)
}

#[command]
pub fn get_pixabay_api_key(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let db_path = get_db_path(&app);
    db::get_setting(&db_path, "pixabay_api_key").map_err(|e| e.to_string())
}

#[command]
pub fn set_pixabay_api_key(app: tauri::AppHandle, api_key: String) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::set_setting(&db_path, "pixabay_api_key", &api_key).map_err(|e| e.to_string())
}

#[command]
pub async fn fetch_image_as_data_uri(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client.get(&url)
        .send()
        .await
        .map_err(|e| format!("Failed to fetch image: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to fetch image: {}", response.status()));
    }

    let bytes = response.bytes()
        .await
        .map_err(|e| format!("Failed to read image: {}", e))?;

    // Simple mime check
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"\xFF\xD8\xFF") {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.len() > 12 && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/jpeg"
    };

    let base64 = base64_encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, base64))
}
