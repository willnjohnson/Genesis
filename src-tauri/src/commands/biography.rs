use crate::{db, get_db_path};
use serde::{Deserialize, Serialize};
use tauri::command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiographyEntry {
    pub handle: String,
    pub display_name: String,
    pub bio: String,
    pub wikipedia: String,
    pub website: String,
    pub twitter: String,
    pub instagram: String,
    pub facebook: String,
    pub threads: String,
    pub youtube: String,
    pub tiktok: String,
    pub twitch: String,
    pub reddit: String,
    pub discord: String,
}

fn map_row(row: db::BiographyRow) -> BiographyEntry {
    BiographyEntry {
        handle: row.0,
        display_name: row.1,
        bio: row.2,
        wikipedia: row.3,
        website: row.4,
        twitter: row.5,
        instagram: row.6,
        facebook: row.7,
        threads: row.8,
        youtube: row.9,
        tiktok: row.10,
        twitch: row.11,
        reddit: row.12,
        discord: row.13,
    }
}

#[command]
pub fn get_biographies(app: tauri::AppHandle) -> Result<Vec<BiographyEntry>, String> {
    let db_path = get_db_path(&app);
    let rows = db::get_biographies(&db_path).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(map_row).collect())
}

#[command]
pub fn get_biography(app: tauri::AppHandle, handle: String) -> Result<Option<BiographyEntry>, String> {
    let db_path = get_db_path(&app);
    let row = db::get_biography_by_handle(&db_path, &handle).map_err(|e| e.to_string())?;
    Ok(row.map(map_row))
}

#[command]
#[allow(clippy::too_many_arguments)]
pub fn update_biography(
    app: tauri::AppHandle,
    handle: String,
    bio: String,
    wikipedia: String,
    website: String,
    twitter: String,
    instagram: String,
    facebook: String,
    threads: String,
    youtube: String,
    tiktok: String,
    twitch: String,
    reddit: String,
    discord: String,
) -> Result<(), String> {
    let db_path = get_db_path(&app);
    db::update_biography_details(
        &db_path,
        &handle,
        &bio,
        &wikipedia,
        &website,
        &twitter,
        &instagram,
        &facebook,
        &threads,
        &youtube,
        &tiktok,
        &twitch,
        &reddit,
        &discord,
    )
    .map_err(|e| e.to_string())
}
