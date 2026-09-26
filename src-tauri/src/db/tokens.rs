//! Search tokens for a video, computed in Rust: the same words `regenerate_tokens_from_transcript`
//! (db/search.rs) produces, for the places that have to do it for thousands of videos at once (a
//! Kinpak or sync import).
//!
//! That SQL finds each word by asking SQLite for the character at position `n`, for every `n`. Those
//! lookups get slower the further into the text they go, so the cost grows with the square of a
//! transcript's length: fine for one transcript being saved, but minutes for a library of long ones.
//! This makes one pass over the text instead. It reproduces the SQL's rules exactly, quirks included
//! (a test compares the two): words are only found starting in the first 50,000 characters, `LOWER`
//! folds ASCII only, and only spaces, tabs and line breaks separate words.

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension, Result};

/// The SQL only looks for words that start within this many characters of the (normalized) text.
const MAX_WORD_START: usize = 50_000;

/// Punctuation the SQL strips from every word.
const STRIPPED: [char; 11] = ['.', ',', '!', '?', ';', ':', '"', '\'', '-', '(', ')'];

/// The tokens for `transcript`: distinct, lowercased, punctuation-stripped words that aren't stop
/// words, space-separated in the order they first appear. `None` when there's nothing to store,
/// which is when the SQL leaves the column alone too (an empty or `N/A` transcript, or only stop words).
pub fn transcript_tokens(transcript: &str, stop_words: &HashSet<String>) -> Option<String> {
    if transcript == "N/A" {
        return None;
    }
    let mut text = transcript.replace(['\n', '\r', '\t'], " ");
    // The SQL squeezes runs of spaces with eight passes of REPLACE('  ', ' '); doing the same keeps
    // word positions identical even in the odd text that still has a run left after them.
    for _ in 0..8 {
        if !text.contains("  ") {
            break;
        }
        text = text.replace("  ", " ");
    }
    // TRIM() strips spaces only; the text is then padded with one space on each side.
    let chars: Vec<char> = std::iter::once(' ').chain(text.trim_matches(' ').chars()).chain(std::iter::once(' ')).collect();

    let mut seen: HashSet<String> = HashSet::new();
    let mut tokens: Vec<String> = Vec::new();
    // `n` is the 1-based position of the space that precedes a word (as in the SQL).
    let last = MAX_WORD_START.min(chars.len().saturating_sub(1));
    for n in 1..=last {
        if chars[n - 1] != ' ' || chars[n] == ' ' {
            continue;
        }
        let mut word = String::new();
        for &c in &chars[n..] {
            if c == ' ' {
                break;
            }
            if !STRIPPED.contains(&c) {
                word.push(c.to_ascii_lowercase());
            }
        }
        if word.is_empty() || stop_words.contains(&word) || !seen.insert(word.clone()) {
            continue;
        }
        tokens.push(word);
    }
    if tokens.is_empty() { None } else { Some(tokens.join(" ")) }
}

/// The stop words of this database (empty when the table doesn't exist).
pub fn load_stop_words(conn: &Connection) -> HashSet<String> {
    let Ok(mut stmt) = conn.prepare("SELECT culls FROM StopWords") else {
        return HashSet::new();
    };
    let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
        return HashSet::new();
    };
    rows.filter_map(|r| r.ok()).collect()
}

/// Stores the tokens for a video whose transcript is `transcript` (no-op when there are none).
pub fn set_tokens_from_transcript(conn: &Connection, video_id: &str, transcript: &str, stop_words: &HashSet<String>) -> Result<()> {
    if let Some(tokens) = transcript_tokens(transcript, stop_words) {
        conn.execute("UPDATE Videos SET tokens = ?1 WHERE video_id = ?2", params![tokens, video_id])?;
    }
    Ok(())
}

/// Rebuilds a video's tokens from the transcript stored for it. What every save uses: the SQL version
/// (`regenerate_tokens_from_transcript`, kept for the tests to compare against) took 13 seconds for a
/// 50,000-character transcript and nearly two minutes for a million, where this takes well under a
/// second, and gives the same words.
pub fn regenerate_tokens(conn: &Connection, video_id: &str) -> Result<()> {
    let transcript: Option<String> = conn
        .query_row("SELECT transcript FROM Videos WHERE video_id = ?1", params![video_id], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten();
    if let Some(transcript) = transcript {
        set_tokens_from_transcript(conn, video_id, &transcript, &load_stop_words(conn))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;
    use crate::db::search::regenerate_tokens_from_transcript;

    fn temp_db(name: &str) -> String {
        let p = std::env::temp_dir().join(format!("kinesis_tokens_{}_{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&p);
        let s = p.to_string_lossy().to_string();
        init_db(&s).unwrap();
        s
    }

    fn set(s: &str) -> std::collections::BTreeSet<String> {
        s.split_whitespace().map(str::to_string).collect()
    }

    /// The SQL's tokens for `transcript`, as a set (its word order is unspecified).
    fn sql_tokens(db: &str, transcript: &str) -> Option<String> {
        let conn = Connection::open(db).unwrap();
        conn.execute("DELETE FROM Videos", []).unwrap();
        conn.execute("INSERT INTO Videos (video_id, transcript, tokens) VALUES ('v', ?1, '')", params![transcript]).unwrap();
        regenerate_tokens_from_transcript(&conn, "v").unwrap();
        let t: String = conn.query_row("SELECT tokens FROM Videos WHERE video_id='v'", [], |r| r.get(0)).unwrap();
        if t.is_empty() { None } else { Some(t) }
    }

    #[test]
    fn it_produces_the_same_words_as_the_sql() {
        let db = temp_db("same");
        let stop = load_stop_words(&Connection::open(&db).unwrap());
        assert!(stop.contains("the"), "the default stop words are loaded");

        let long_words: String = (0..12_000).map(|i| format!("word{} ", i % 4_000)).collect(); // well past 50,000 chars
        let cases: Vec<String> = vec![
            "The quick brown fox jumps over the lazy dog".into(),
            "Hello, world! It's a well-known (and odd) fact: \"quoted\" words; really?".into(),
            "tabs\tand\nnewlines\r\nand   multiple     spaces   in   a   row".into(),
            "  leading and trailing spaces   ".into(),
            "Café ÉCOLE Ünïcode naïve — ASCII-only lowercasing".into(),
            "repeat repeat REPEAT Repeat".into(),
            "one".into(),
            "".into(),
            "   ".into(),
            "the and of a".into(),
            "N/A".into(),
            "a.b c,d e-f g'h ---".into(),
            "nbsp\u{00A0}joined\u{00A0}words and\u{000B}vt".into(),
            format!("{}{}", "space".repeat(1) + &" ".repeat(20), "after a long run of spaces"),
            long_words,
        ];
        for text in cases {
            let want = sql_tokens(&db, &text);
            let got = transcript_tokens(&text, &stop);
            assert_eq!(
                want.as_deref().map(set),
                got.as_deref().map(set),
                "tokens differ for {:?}",
                text.chars().take(60).collect::<String>()
            );
        }
    }

    #[test]
    fn nothing_is_stored_when_there_are_no_tokens() {
        let db = temp_db("none");
        let conn = Connection::open(&db).unwrap();
        conn.execute("INSERT INTO Videos (video_id, transcript, tokens) VALUES ('v', 'x', 'kept')", []).unwrap();
        let stop = load_stop_words(&conn);
        for text in ["", "N/A", "the of and"] {
            set_tokens_from_transcript(&conn, "v", text, &stop).unwrap();
            let t: String = conn.query_row("SELECT tokens FROM Videos WHERE video_id='v'", [], |r| r.get(0)).unwrap();
            assert_eq!(t, "kept", "{text:?} must leave the tokens alone, like the SQL");
        }
        set_tokens_from_transcript(&conn, "v", "Fresh Words here", &stop).unwrap();
        let t: String = conn.query_row("SELECT tokens FROM Videos WHERE video_id='v'", [], |r| r.get(0)).unwrap();
        assert_eq!(set(&t), set("fresh words"));
    }

    #[test]
    fn a_long_transcript_is_fast() {
        // The SQL takes seconds on this; a single pass must not.
        let text: String = (0..60_000).map(|i| format!("w{} ", i)).collect();
        let started = std::time::Instant::now();
        let tokens = transcript_tokens(&text, &HashSet::new()).unwrap();
        assert!(tokens.split(' ').count() > 1_000);
        assert!(started.elapsed().as_secs() < 5, "took {:?}", started.elapsed());
    }

    /// `cargo test --lib -- --ignored --nocapture save_speed`: how long saving a long transcript takes
    /// through the old SQL tokenizer versus the Rust one.
    #[test]
    #[ignore]
    fn save_speed() {
        let db = temp_db("speed");
        let words = ["alpha", "beta", "gamma", "delta", "mitochondria", "epsilon", "zeta,", "eta.", "theta"];
        for chars in [50_000usize, 300_000, 1_000_000] {
            let mut text = String::with_capacity(chars + 16);
            let mut i = 0;
            while text.len() < chars {
                text.push_str(words[i % words.len()]);
                text.push_str(if i % 12 == 11 { "
" } else { " " });
                i += 1;
            }
            let conn = Connection::open(&db).unwrap();
            conn.execute("DELETE FROM Videos", []).unwrap();
            conn.execute("INSERT INTO Videos (video_id, transcript, tokens) VALUES ('v', ?1, '')", params![text]).unwrap();
            let t = std::time::Instant::now();
            regenerate_tokens_from_transcript(&conn, "v").unwrap();
            let sql = t.elapsed();
            let stop = load_stop_words(&conn);
            let t = std::time::Instant::now();
            set_tokens_from_transcript(&conn, "v", &text, &stop).unwrap();
            let rust = t.elapsed();
            println!("{chars:>9} chars: SQL {sql:?}, Rust {rust:?}");
        }
    }
}
