use serde_json::Value;
use sha2::{Digest, Sha256};

/// Serializes `value` with object keys sorted recursively, so the same logical content always
/// produces the same bytes regardless of map ordering (serde_json's `preserve_order` feature can
/// be switched on by other crates in the dependency graph, so we sort explicitly).
pub fn canonical_json(value: &Value) -> String {
    let mut out = String::new();
    write_canonical(value, &mut out);
    out
}

fn write_canonical(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            out.push('{');
            for (i, k) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_default());
                out.push(':');
                write_canonical(&map[*k], out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (i, v) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(v, out);
            }
            out.push(']');
        }
        other => out.push_str(&other.to_string()),
    }
}

/// Hex sha256 over the canonical JSON form of `kind`, `key` and `data`.
pub fn content_hash(kind: &str, key: &str, data: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(kind.as_bytes());
    hasher.update([0u8]);
    hasher.update(key.as_bytes());
    hasher.update([0u8]);
    hasher.update(canonical_json(data).as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for b in digest {
        hex.push_str(&format!("{:02x}", b));
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_form_ignores_key_order() {
        let a = json!({"b": 1, "a": {"y": [1, 2], "x": null}});
        let b = json!({"a": {"x": null, "y": [1, 2]}, "b": 1});
        assert_eq!(canonical_json(&a), canonical_json(&b));
        assert_eq!(canonical_json(&a), r#"{"a":{"x":null,"y":[1,2]},"b":1}"#);
    }

    #[test]
    fn hash_depends_on_kind_key_and_data() {
        let d = json!({"title": "t"});
        let h = content_hash("video", "abc", &d);
        assert_eq!(h.len(), 64);
        assert_eq!(h, content_hash("video", "abc", &json!({"title": "t"})));
        assert_ne!(h, content_hash("glossary", "abc", &d));
        assert_ne!(h, content_hash("video", "abd", &d));
        assert_ne!(h, content_hash("video", "abc", &json!({"title": "u"})));
    }

    #[test]
    fn kind_and_key_boundary_is_unambiguous() {
        let d = json!(null);
        assert_ne!(content_hash("ab", "c", &d), content_hash("a", "bc", &d));
    }
}
