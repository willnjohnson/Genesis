//! NDJSON "sync pack": one JSON object per line, optionally gzip-compressed.
//!
//! Line 1 is a header, later lines are content items (same envelope as `/changes` upserts) and at
//! most one policy line. Streaming line by line keeps large libraries (transcripts) out of memory.

use std::io::{self, BufRead, BufReader, Read, Write};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::{Item, Policy};
use crate::{PACK_FORMAT, PACK_VERSION};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackHeader {
    pub format: String,
    pub pack_version: u32,
    pub generated_at: String,
    #[serde(default)]
    pub app: String,
    #[serde(default)]
    pub brand: String,
    #[serde(default)]
    pub counts: std::collections::BTreeMap<String, u64>,
}

impl PackHeader {
    pub fn new(generated_at: &str, app: &str, brand: &str) -> Self {
        PackHeader {
            format: PACK_FORMAT.to_string(),
            pack_version: PACK_VERSION,
            generated_at: generated_at.to_string(),
            app: app.to_string(),
            brand: brand.to_string(),
            counts: Default::default(),
        }
    }
}

#[derive(Debug, Clone)]
pub enum PackLine {
    Header(PackHeader),
    Item(Item),
    Policy(Policy),
}

enum Sink<W: Write> {
    Plain(W),
    Gzip(GzEncoder<W>),
}

impl<W: Write> Write for Sink<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Sink::Plain(w) => w.write(buf),
            Sink::Gzip(w) => w.write(buf),
        }
    }
    fn flush(&mut self) -> io::Result<()> {
        match self {
            Sink::Plain(w) => w.flush(),
            Sink::Gzip(w) => w.flush(),
        }
    }
}

pub struct PackWriter<W: Write> {
    sink: Sink<W>,
}

impl<W: Write> PackWriter<W> {
    pub fn new(inner: W, gzip: bool) -> Self {
        let sink = if gzip {
            Sink::Gzip(GzEncoder::new(inner, Compression::default()))
        } else {
            Sink::Plain(inner)
        };
        PackWriter { sink }
    }

    fn write_line(&mut self, value: &Value) -> io::Result<()> {
        serde_json::to_writer(&mut self.sink, value).map_err(io::Error::other)?;
        self.sink.write_all(b"\n")
    }

    /// Must be called first. `counts` are informational (progress UIs), not authoritative.
    pub fn write_header(&mut self, header: &PackHeader) -> io::Result<()> {
        let mut v = serde_json::to_value(header).map_err(io::Error::other)?;
        v["kind"] = Value::String("header".into());
        self.write_line(&v)
    }

    pub fn write_item(&mut self, item: &Item) -> io::Result<()> {
        self.write_line(&serde_json::to_value(item).map_err(io::Error::other)?)
    }

    pub fn write_policy(&mut self, policy: &Policy) -> io::Result<()> {
        let mut v = serde_json::to_value(policy).map_err(io::Error::other)?;
        v["kind"] = Value::String("policy".into());
        self.write_line(&v)
    }

    /// Flushes and finalizes the gzip stream (if any), returning the underlying writer.
    pub fn finish(self) -> io::Result<W> {
        match self.sink {
            Sink::Plain(mut w) => {
                w.flush()?;
                Ok(w)
            }
            Sink::Gzip(w) => w.finish(),
        }
    }
}

pub struct PackReader {
    inner: Box<dyn BufRead>,
    line_no: usize,
    last_len: usize,
}

impl PackReader {
    /// Detects gzip by magic bytes, so callers don't need to care how the pack was written.
    pub fn new<R: Read + 'static>(reader: R) -> io::Result<Self> {
        let mut buffered = BufReader::new(reader);
        let is_gzip = {
            let head = buffered.fill_buf()?;
            head.len() >= 2 && head[0] == 0x1f && head[1] == 0x8b
        };
        let inner: Box<dyn BufRead> = if is_gzip {
            Box::new(BufReader::new(GzDecoder::new(buffered)))
        } else {
            Box::new(buffered)
        };
        Ok(PackReader { inner, line_no: 0, last_len: 0 })
    }

    /// Reads one line without ever buffering more than `MAX_LINE_BYTES`, so a hostile file can't
    /// force a huge allocation. `None` at end of input.
    fn read_bounded_line(&mut self) -> Result<Option<Vec<u8>>, String> {
        let mut line: Vec<u8> = Vec::new();
        loop {
            let (consumed, done) = {
                let chunk = self.inner.fill_buf().map_err(|e| format!("read error: {e}"))?;
                if chunk.is_empty() {
                    return Ok(if line.is_empty() { None } else { Some(line) });
                }
                match chunk.iter().position(|b| *b == b'\n') {
                    Some(pos) => {
                        line.extend_from_slice(&chunk[..pos]);
                        (pos + 1, true)
                    }
                    None => {
                        line.extend_from_slice(chunk);
                        (chunk.len(), false)
                    }
                }
            };
            self.inner.consume(consumed);
            if line.len() > MAX_LINE_BYTES {
                return Err(format!("line {}: longer than {MAX_LINE_BYTES} bytes", self.line_no + 1));
            }
            if done {
                return Ok(Some(line));
            }
        }
    }

    /// Next non-blank line, or `None` at end of input.
    pub fn next_line(&mut self) -> Result<Option<PackLine>, String> {
        loop {
            let Some(bytes) = self.read_bounded_line()? else {
                return Ok(None);
            };
            self.line_no += 1;
            let text = String::from_utf8(bytes).map_err(|_| format!("line {}: not valid UTF-8", self.line_no))?;
            if text.trim().is_empty() {
                continue;
            }
            self.last_len = text.len();
            return parse_line(text.trim_end(), self.line_no).map(Some);
        }
    }

    /// Byte length of the line `next_line` last returned, so callers can bound batch memory.
    pub fn last_line_bytes(&self) -> usize {
        self.last_len
    }
}

/// One item plus envelope must fit in this (an item itself is capped at `MAX_ITEM_BYTES`).
const MAX_LINE_BYTES: usize = crate::MAX_ITEM_BYTES + 64 * 1024;

fn parse_line(line: &str, line_no: usize) -> Result<PackLine, String> {
    let v: Value = serde_json::from_str(line).map_err(|e| format!("line {line_no}: invalid JSON: {e}"))?;
    let kind = v.get("kind").and_then(Value::as_str).unwrap_or("").to_string();
    match kind.as_str() {
        "header" => serde_json::from_value(v)
            .map(PackLine::Header)
            .map_err(|e| format!("line {line_no}: bad header: {e}")),
        "policy" => serde_json::from_value(v)
            .map(PackLine::Policy)
            .map_err(|e| format!("line {line_no}: bad policy: {e}")),
        "" => Err(format!("line {line_no}: missing kind")),
        _ => serde_json::from_value(v)
            .map(PackLine::Item)
            .map_err(|e| format!("line {line_no}: bad item: {e}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_item(key: &str) -> Item {
        Item {
            kind: "glossary".into(),
            key: key.into(),
            rev: None,
            hash: crate::content_hash("glossary", key, &json!({"definition": "d"})),
            data: json!({"definition": "d"}),
        }
    }

    fn round_trip(gzip: bool) {
        let mut w = PackWriter::new(Vec::new(), gzip);
        let mut header = PackHeader::new("2026-01-01T00:00:00Z", "Kinesis 0.4.2", "Kinesis");
        header.counts.insert("glossary".into(), 2);
        w.write_header(&header).unwrap();
        w.write_item(&sample_item("alpha")).unwrap();
        w.write_item(&sample_item("beta")).unwrap();
        let mut policy = Policy::default();
        policy.settings.insert("showBiography".into(), "false".into());
        policy.locked.push("showBiography".into());
        w.write_policy(&policy).unwrap();
        let bytes = w.finish().unwrap();

        assert_eq!(bytes.starts_with(&[0x1f, 0x8b]), gzip);

        let mut r = PackReader::new(io::Cursor::new(bytes)).unwrap();
        match r.next_line().unwrap().unwrap() {
            PackLine::Header(h) => {
                assert_eq!(h.format, PACK_FORMAT);
                assert_eq!(h.counts.get("glossary"), Some(&2));
            }
            other => panic!("expected header, got {other:?}"),
        }
        let mut keys = vec![];
        let mut saw_policy = false;
        while let Some(line) = r.next_line().unwrap() {
            match line {
                PackLine::Item(i) => keys.push(i.key),
                PackLine::Policy(p) => {
                    saw_policy = true;
                    assert_eq!(p.settings.get("showBiography").map(String::as_str), Some("false"));
                    assert_eq!(p.locked, vec!["showBiography".to_string()]);
                }
                PackLine::Header(_) => panic!("second header"),
            }
        }
        assert_eq!(keys, vec!["alpha", "beta"]);
        assert!(saw_policy);
    }

    #[test]
    fn plain_round_trip() {
        round_trip(false);
    }

    #[test]
    fn gzip_round_trip() {
        round_trip(true);
    }

    #[test]
    fn rejects_garbage_and_missing_kind() {
        let mut r = PackReader::new(io::Cursor::new(b"not json\n".to_vec())).unwrap();
        assert!(r.next_line().is_err());
        let mut r = PackReader::new(io::Cursor::new(b"{\"key\":\"x\"}\n".to_vec())).unwrap();
        assert!(r.next_line().unwrap_err().contains("missing kind"));
    }

    #[test]
    fn oversized_lines_are_rejected_without_unbounded_buffering() {
        let mut data = vec![b'x'; MAX_LINE_BYTES + 10];
        data.push(b'\n');
        let mut r = PackReader::new(io::Cursor::new(data)).unwrap();
        assert!(r.next_line().unwrap_err().contains("longer than"));
    }

    #[test]
    fn a_final_line_without_newline_is_still_read() {
        let line = br#"{"kind":"glossary","key":"k","data":{}}"#.to_vec();
        let mut r = PackReader::new(io::Cursor::new(line)).unwrap();
        assert!(matches!(r.next_line().unwrap(), Some(PackLine::Item(_))));
    }

    #[test]
    fn blank_lines_are_skipped() {
        let mut r = PackReader::new(io::Cursor::new(b"\n\n".to_vec())).unwrap();
        assert!(r.next_line().unwrap().is_none());
    }
}
