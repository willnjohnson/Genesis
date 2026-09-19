//! Per-video notes and attachments, stored inside the database.
//!
//! Files are content-addressed: `attachment_blobs` holds each distinct file once, keyed by the
//! sha256 of its original bytes, and `video_attachments` points videos at blobs. That keeps identical
//! files from being stored twice, lets every read check its bytes against the hash, and gives a future
//! sync a natural unit to ship. Compressible types are deflated, but only when that is smaller, and
//! only after decompressing the result proves it gives back exactly the original bytes.

use flate2::{read::DeflateDecoder, write::DeflateEncoder, Compression};
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};

pub const MAX_ATTACHMENTS: usize = 5;
/// A file must be smaller than this (128 MiB).
pub const MAX_ATTACHMENT_BYTES: u64 = 128 * 1024 * 1024;

pub const ALLOWED_EXTENSIONS: &[&str] = &[
    "pdf", "txt", "md", "docx", "csv", "xlsx", "pptx", "html", "json", "xml", "png", "jpeg", "jpg", "webp", "gif", "svg",
];

/// Types whose bytes deflate well. The rest (images, and the zip-based Office formats) are already
/// compressed, so trying would only cost time.
const COMPRESSIBLE_EXTENSIONS: &[&str] = &["txt", "md", "csv", "html", "json", "xml", "svg", "pdf"];

const NAME_MAX_CHARS: usize = 200;

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub id: i64,
    pub name: String,
    pub ext: String,
    /// Size of the original file, in bytes.
    pub size: i64,
    /// Bytes actually kept in the database (smaller than `size` when compressed).
    pub stored_size: i64,
    pub added_at: String,
}

fn db_err(e: rusqlite::Error) -> String {
    format!("Database error: {e}")
}

pub fn extension_of(name: &str) -> Option<String> {
    let (_, ext) = name.rsplit_once('.')?;
    let ext = ext.to_lowercase();
    ALLOWED_EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// The file's base name only, with control characters removed and a sane length.
fn clean_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw);
    let cleaned: String = base.chars().filter(|c| !c.is_control()).collect();
    let cleaned = cleaned.trim().to_string();
    if cleaned.chars().count() <= NAME_MAX_CHARS {
        return cleaned;
    }
    // Keep the extension when shortening.
    let ext = cleaned.rsplit_once('.').map(|(_, e)| format!(".{e}")).unwrap_or_default();
    let stem: String = cleaned.chars().take(NAME_MAX_CHARS.saturating_sub(ext.chars().count())).collect();
    format!("{stem}{ext}")
}

/// Why a file can't be added, or its (lowercase) extension when it can.
pub fn validate_file(name: &str, size: u64) -> std::result::Result<String, String> {
    let ext = extension_of(name).ok_or_else(|| {
        format!("\"{name}\" isn't a supported type. Allowed: {}.", ALLOWED_EXTENSIONS.join(", "))
    })?;
    if size == 0 {
        return Err(format!("\"{name}\" is empty."));
    }
    if size >= MAX_ATTACHMENT_BYTES {
        return Err(format!("\"{name}\" is too large. Each attachment must be under 128 MB."));
    }
    Ok(ext)
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn deflate(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut enc = DeflateEncoder::new(Vec::with_capacity(bytes.len() / 2), Compression::default());
    enc.write_all(bytes)?;
    enc.finish()
}

fn inflate(bytes: &[u8]) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    DeflateDecoder::new(bytes).read_to_end(&mut out)?;
    Ok(out)
}

/// How to store `bytes` for a file of type `ext`: ("deflate", compressed) when that is smaller and
/// provably lossless, else ("none", the bytes as they are).
fn encode(ext: &str, bytes: &[u8], hash: &str) -> (&'static str, Vec<u8>) {
    if COMPRESSIBLE_EXTENSIONS.contains(&ext) {
        if let Ok(packed) = deflate(bytes) {
            if packed.len() < bytes.len() {
                if let Ok(back) = inflate(&packed) {
                    if sha256_hex(&back) == hash {
                        return ("deflate", packed);
                    }
                }
            }
        }
    }
    ("none", bytes.to_vec())
}

fn decode(compression: &str, data: Vec<u8>) -> std::result::Result<Vec<u8>, String> {
    match compression {
        "none" => Ok(data),
        "deflate" => inflate(&data).map_err(|e| format!("The stored attachment is damaged ({e}).")),
        other => Err(format!("The stored attachment uses an unknown compression \"{other}\".")),
    }
}

fn video_exists(conn: &Connection, video_id: &str) -> Result<bool> {
    Ok(conn
        .query_row("SELECT 1 FROM videos WHERE video_id = ?1", params![video_id], |_| Ok(()))
        .optional()?
        .is_some())
}

fn attachment_count(conn: &Connection, video_id: &str) -> Result<usize> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM video_attachments WHERE video_id = ?1",
        params![video_id],
        |r| r.get(0),
    )?;
    Ok(n as usize)
}

fn limit_message() -> String {
    format!("A video can have at most {MAX_ATTACHMENTS} attachments. Remove one to add another.")
}

/// Adds one file (given as bytes) to a saved video.
pub fn add_attachment(db_path: &str, video_id: &str, file_name: &str, bytes: Vec<u8>) -> std::result::Result<AttachmentInfo, String> {
    let name = clean_name(file_name);
    let ext = validate_file(&name, bytes.len() as u64)?;

    let hash = sha256_hex(&bytes);
    let size = bytes.len() as i64;
    let (compression, data) = encode(&ext, &bytes, &hash);
    drop(bytes);
    let stored_size = data.len() as i64;

    let mut conn = Connection::open(db_path).map_err(db_err)?;
    conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(db_err)?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate).map_err(db_err)?;
    if !video_exists(&tx, video_id).map_err(db_err)? {
        return Err("Save the video to the library before attaching files to it.".to_string());
    }
    // Counted inside the transaction, so two adds at once can't slip past the limit.
    if attachment_count(&tx, video_id).map_err(db_err)? >= MAX_ATTACHMENTS {
        return Err(limit_message());
    }
    tx.execute(
        "INSERT OR IGNORE INTO attachment_blobs (hash, compression, size, stored_size, data) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![hash, compression, size, stored_size, data],
    )
    .map_err(db_err)?;
    tx.execute(
        "INSERT INTO video_attachments (video_id, name, ext, hash, added_at) VALUES (?1, ?2, ?3, ?4, strftime('%Y-%m-%dT%H:%M:%SZ','now'))",
        params![video_id, name, ext, hash],
    )
    .map_err(db_err)?;
    let id = tx.last_insert_rowid();
    // Whatever an earlier identical file was stored as is what counts, so report from the row.
    let info = load_info(&tx, id).map_err(db_err)?.ok_or_else(|| "The attachment could not be read back.".to_string())?;
    tx.commit().map_err(db_err)?;
    Ok(info)
}

/// Adds a file from disk. The size and type are checked from the path and its metadata before any
/// of it is read, so a huge or unsupported file costs nothing.
pub fn add_attachment_from_path(db_path: &str, video_id: &str, path: &std::path::Path) -> std::result::Result<AttachmentInfo, String> {
    let file_name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let name = clean_name(&file_name);
    let meta = std::fs::metadata(path).map_err(|e| format!("Couldn't read \"{name}\": {e}"))?;
    if !meta.is_file() {
        return Err(format!("\"{name}\" isn't a file."));
    }
    validate_file(&name, meta.len())?;
    {
        let conn = Connection::open(db_path).map_err(db_err)?;
        if attachment_count(&conn, video_id).map_err(db_err)? >= MAX_ATTACHMENTS {
            return Err(limit_message());
        }
    }
    let bytes = std::fs::read(path).map_err(|e| format!("Couldn't read \"{name}\": {e}"))?;
    add_attachment(db_path, video_id, &name, bytes)
}

fn load_info(conn: &Connection, id: i64) -> Result<Option<AttachmentInfo>> {
    conn.query_row(
        "SELECT a.id, a.name, a.ext, b.size, b.stored_size, a.added_at
           FROM video_attachments a JOIN attachment_blobs b ON b.hash = a.hash WHERE a.id = ?1",
        params![id],
        row_to_info,
    )
    .optional()
}

fn row_to_info(row: &rusqlite::Row) -> Result<AttachmentInfo> {
    Ok(AttachmentInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        ext: row.get(2)?,
        size: row.get(3)?,
        stored_size: row.get(4)?,
        added_at: row.get(5)?,
    })
}

pub fn list_attachments(db_path: &str, video_id: &str) -> Result<Vec<AttachmentInfo>> {
    let conn = Connection::open(db_path)?;
    let mut stmt = conn.prepare(
        "SELECT a.id, a.name, a.ext, b.size, b.stored_size, a.added_at
           FROM video_attachments a JOIN attachment_blobs b ON b.hash = a.hash
          WHERE a.video_id = ?1 ORDER BY a.id",
    )?;
    let rows = stmt.query_map(params![video_id], row_to_info)?;
    rows.collect()
}

/// Removes one attachment, and its stored bytes too once no other video uses them.
pub fn remove_attachment(db_path: &str, id: i64) -> Result<()> {
    let conn = Connection::open(db_path)?;
    conn.execute("DELETE FROM video_attachments WHERE id = ?1", params![id])?;
    conn.execute(
        "DELETE FROM attachment_blobs WHERE hash NOT IN (SELECT hash FROM video_attachments)",
        [],
    )?;
    Ok(())
}

/// The file's name and original bytes, checked against the hash they were stored under.
pub fn read_attachment(db_path: &str, id: i64) -> std::result::Result<(String, Vec<u8>), String> {
    let conn = Connection::open(db_path).map_err(db_err)?;
    let row: Option<(String, String, String, Vec<u8>)> = conn
        .query_row(
            "SELECT a.name, a.hash, b.compression, b.data
               FROM video_attachments a JOIN attachment_blobs b ON b.hash = a.hash WHERE a.id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(db_err)?;
    let (name, hash, compression, data) = row.ok_or_else(|| "That attachment no longer exists.".to_string())?;
    let bytes = decode(&compression, data)?;
    if sha256_hex(&bytes) != hash {
        return Err(format!("\"{name}\" failed its integrity check, so it was not opened."));
    }
    Ok((name, bytes))
}

pub fn get_note(db_path: &str, video_id: &str) -> Result<String> {
    let conn = Connection::open(db_path)?;
    Ok(conn
        .query_row("SELECT note FROM video_notes WHERE video_id = ?1", params![video_id], |r| r.get(0))
        .optional()?
        .unwrap_or_default())
}

/// Saves the video's note; a blank note removes it.
pub fn set_note(db_path: &str, video_id: &str, note: &str) -> std::result::Result<(), String> {
    let conn = Connection::open(db_path).map_err(db_err)?;
    if !video_exists(&conn, video_id).map_err(db_err)? {
        return Err("Save the video to the library before adding a note to it.".to_string());
    }
    if note.trim().is_empty() {
        conn.execute("DELETE FROM video_notes WHERE video_id = ?1", params![video_id]).map_err(db_err)?;
    } else {
        conn.execute(
            "INSERT INTO video_notes (video_id, note, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
             ON CONFLICT(video_id) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
            params![video_id, note],
        )
        .map_err(db_err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{delete_video, init_db, save_video};

    fn temp_db(name: &str) -> String {
        let path = std::env::temp_dir().join(format!("kinesis_attach_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let p = path.to_string_lossy().to_string();
        init_db(&p).unwrap();
        p
    }

    fn video(db: &str, id: &str) {
        save_video(db, id, id, "Author", 60, "words", 1, "2026-01-01T00:00:00Z", "@chan", None).unwrap();
    }

    fn blob_count(db: &str) -> i64 {
        Connection::open(db).unwrap().query_row("SELECT COUNT(*) FROM attachment_blobs", [], |r| r.get(0)).unwrap()
    }

    /// Bytes that don't compress: a simple xorshift stream.
    fn noise(len: usize) -> Vec<u8> {
        let mut x: u64 = 0x9E3779B97F4A7C15;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                (x >> 24) as u8
            })
            .collect()
    }

    #[test]
    fn text_is_compressed_and_comes_back_byte_for_byte() {
        let db = temp_db("text");
        video(&db, "v1");
        let text = "The halving cuts the block reward in half. ".repeat(5000).into_bytes();
        let info = add_attachment(&db, "v1", "notes.txt", text.clone()).unwrap();
        assert_eq!(info.size as usize, text.len());
        assert!(info.stored_size < info.size / 10, "repetitive text should shrink a lot: {info:?}");
        let (name, back) = read_attachment(&db, info.id).unwrap();
        assert_eq!(name, "notes.txt");
        assert_eq!(back, text);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn incompressible_and_already_compressed_files_are_stored_as_they_are() {
        let db = temp_db("noise");
        video(&db, "v1");
        let random = noise(50_000);
        // Compressible type, but the bytes don't shrink: kept raw.
        let a = add_attachment(&db, "v1", "data.json", random.clone()).unwrap();
        assert_eq!(a.stored_size, a.size);
        // An image type is never deflated.
        let b = add_attachment(&db, "v1", "photo.PNG", random.clone()).unwrap();
        assert_eq!(b.stored_size, b.size);
        assert_eq!(b.ext, "png");
        assert_eq!(read_attachment(&db, a.id).unwrap().1, random);
        assert_eq!(read_attachment(&db, b.id).unwrap().1, random);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_damaged_blob_is_caught_on_read() {
        let db = temp_db("damage");
        video(&db, "v1");
        let info = add_attachment(&db, "v1", "a.txt", b"hello hello hello hello".repeat(50)).unwrap();
        let conn = Connection::open(&db).unwrap();
        conn.execute("UPDATE attachment_blobs SET compression = 'none', data = x'00112233'", []).unwrap();
        let err = read_attachment(&db, info.id).unwrap_err();
        assert!(err.contains("integrity"), "{err}");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn at_most_five_per_video_and_only_supported_types_and_sizes() {
        let db = temp_db("limits");
        video(&db, "v1");
        video(&db, "v2");
        for i in 0..MAX_ATTACHMENTS {
            add_attachment(&db, "v1", &format!("f{i}.txt"), format!("file {i}").into_bytes()).unwrap();
        }
        let err = add_attachment(&db, "v1", "sixth.txt", b"one too many".to_vec()).unwrap_err();
        assert!(err.contains("at most 5"), "{err}");
        // The limit is per video.
        add_attachment(&db, "v2", "ok.txt", b"fine".to_vec()).unwrap();

        assert!(add_attachment(&db, "v2", "run.exe", b"MZ".to_vec()).unwrap_err().contains("supported"));
        assert!(add_attachment(&db, "v2", "noextension", b"x".to_vec()).unwrap_err().contains("supported"));
        assert!(add_attachment(&db, "v2", "empty.txt", Vec::new()).unwrap_err().contains("empty"));
        // Every allowed type is accepted, in any letter case.
        for ext in ALLOWED_EXTENSIONS {
            assert!(validate_file(&format!("x.{}", ext.to_uppercase()), 10).is_ok(), "{ext}");
        }
        // Size is judged from a number, so no 128 MB buffer is needed to test it.
        assert!(validate_file("big.pdf", MAX_ATTACHMENT_BYTES - 1).is_ok());
        assert!(validate_file("big.pdf", MAX_ATTACHMENT_BYTES).unwrap_err().contains("under 128 MB"));
        // Unsaved videos can't hold attachments or notes.
        assert!(add_attachment(&db, "ghost", "a.txt", b"x".to_vec()).unwrap_err().contains("Save the video"));
        assert!(set_note(&db, "ghost", "hi").is_err());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn a_file_on_disk_is_checked_before_it_is_read() {
        let db = temp_db("path");
        video(&db, "v1");
        let dir = std::env::temp_dir().join(format!("kinesis_attach_files_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = dir.join("report.CSV");
        std::fs::write(&good, "a,b\n1,2\n").unwrap();
        let bad = dir.join("tool.exe");
        std::fs::write(&bad, "nope").unwrap();

        let info = add_attachment_from_path(&db, "v1", &good).unwrap();
        assert_eq!((info.name.as_str(), info.ext.as_str()), ("report.CSV", "csv"));
        assert!(add_attachment_from_path(&db, "v1", &bad).is_err());
        assert!(add_attachment_from_path(&db, "v1", &dir.join("missing.txt")).is_err());
        assert!(add_attachment_from_path(&db, "v1", &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn identical_files_share_one_blob_until_both_are_removed() {
        let db = temp_db("dedupe");
        video(&db, "v1");
        video(&db, "v2");
        let a = add_attachment(&db, "v1", "same.txt", b"shared content ".repeat(100)).unwrap();
        let b = add_attachment(&db, "v2", "renamed.txt", b"shared content ".repeat(100)).unwrap();
        assert_eq!(blob_count(&db), 1);
        remove_attachment(&db, a.id).unwrap();
        assert_eq!(blob_count(&db), 1, "still used by v2");
        assert_eq!(read_attachment(&db, b.id).unwrap().1, b"shared content ".repeat(100));
        remove_attachment(&db, b.id).unwrap();
        assert_eq!(blob_count(&db), 0);
        assert!(list_attachments(&db, "v1").unwrap().is_empty());
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn deleting_a_video_removes_its_note_and_attachments_but_resaving_keeps_them() {
        let db = temp_db("cascade");
        video(&db, "v1");
        video(&db, "v2");
        add_attachment(&db, "v1", "a.txt", b"only v1 ".repeat(50)).unwrap();
        add_attachment(&db, "v2", "b.txt", b"only v2 ".repeat(50)).unwrap();
        set_note(&db, "v1", "why these matter").unwrap();

        // Saving the video again (an upsert) must not lose anything.
        video(&db, "v1");
        assert_eq!(list_attachments(&db, "v1").unwrap().len(), 1);
        assert_eq!(get_note(&db, "v1").unwrap(), "why these matter");

        delete_video(&db, "v1").unwrap();
        assert!(list_attachments(&db, "v1").unwrap().is_empty());
        assert_eq!(get_note(&db, "v1").unwrap(), "");
        assert_eq!(blob_count(&db), 1, "v2's file is untouched");
        assert_eq!(list_attachments(&db, "v2").unwrap().len(), 1);
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn notes_are_saved_replaced_and_cleared() {
        let db = temp_db("note");
        video(&db, "v1");
        assert_eq!(get_note(&db, "v1").unwrap(), "");
        set_note(&db, "v1", "first").unwrap();
        set_note(&db, "v1", "second\nline two").unwrap();
        assert_eq!(get_note(&db, "v1").unwrap(), "second\nline two");
        set_note(&db, "v1", "   \n ").unwrap();
        assert_eq!(get_note(&db, "v1").unwrap(), "");
        let _ = std::fs::remove_file(&db);
    }

    #[test]
    fn names_are_reduced_to_a_plain_file_name() {
        assert_eq!(clean_name("C:\\Users\\me\\Docs\\paper.pdf"), "paper.pdf");
        assert_eq!(clean_name("../../etc/passwd.txt"), "passwd.txt");
        assert_eq!(clean_name("bad\u{0007}name.md"), "badname.md");
        let long = format!("{}.pdf", "x".repeat(400));
        let cleaned = clean_name(&long);
        assert_eq!(cleaned.chars().count(), NAME_MAX_CHARS);
        assert!(cleaned.ends_with(".pdf"));
    }
}
