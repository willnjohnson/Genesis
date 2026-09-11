# Replace Biography Handle Trigger in Kinesis

## Goal

Replace the (purged) trigger `trgBiographiesMatchHandleCase_AfterUPD` with the
improved trigger `trgBiographiesSyncHandle_AfterUPD` in the Kinesis codebase.

The new trigger cascades a biography `handle` rename to all `videos` rows whose
handle matches case-insensitively.

## Findings

- **Old trigger not in source.** `trgBiographiesMatchHandleCase_AfterUPD` does
  **not** exist anywhere in the current codebase (confirmed via grep for
  `trgBiographies`, `BiographiesMatchHandle`, `BiographiesSyncHandle`, and all
  `CREATE TRIGGER` occurrences — only four `trg_ftsVideos_*` triggers found).
- **`init_db` is the single schema-creation point.** `src-tauri/src/db/schema.rs:34`
  creates all tables, indexes, and triggers idempotently (`IF NOT EXISTS`) and
  runs on every app startup via `lib.rs:104`.
- **No formal migration system.** Schema changes are applied in-place through
  `init_db`'s idempotent `CREATE`/`DROP IF EXISTS` statements.
- **No existing code path updates `biographies.handle`.** `upsert_biography_from_video`
  uses `ON CONFLICT DO UPDATE` for `display_name` only; `update_biography_details`
  explicitly skips `handle`. The new trigger is dormant until such a path exists.

## Changes

### 1. `src-tauri/src/db/schema.rs` — `init_db` function

After the last existing trigger (`trg_ftsVideos_AfterUPD`, line 232) and before
`Ok(())` (line 234), add:

```rust
    // Drop the legacy biography-handle cascade trigger on first run after
    // upgrade, then create the replacement. DROP IF EXISTS is a safe no-op
    // for databases that never had the old trigger.
    let _ = conn.execute("DROP TRIGGER IF EXISTS trgBiographiesMatchHandleCase_AfterUPD", []);

    let _ = conn.execute(
        "CREATE TRIGGER IF NOT EXISTS trgBiographiesSyncHandle_AfterUPD
        AFTER UPDATE OF handle ON biographies
        WHEN NEW.handle != OLD.handle
        BEGIN
            UPDATE videos
            SET handle = NEW.handle
            WHERE lower(handle) = lower(OLD.handle);
        END",
        [],
    );
```

### 2. `src-tauri/src/db/schema.rs` — update comment (line 192)

Update the comment above the trigger block so it accurately describes the
biography-handle cascade in addition to FTS sync:

```
    // FTS sync triggers + biography handle-rename cascade. The DROP/TRIGGER
    // pair is idempotent and cheap (catalog lookups only), so this stays
    // unconditional like the FTS5 table create above.
```

## Edge Cases & Risks

| Scenario | Handling |
|---|---|
| Old trigger already absent | `DROP TRIGGER IF EXISTS` is a no-op |
| Old trigger present in user DB | Dropped on next app launch, replaced by new trigger |
| New trigger already exists | `CREATE TRIGGER IF NOT EXISTS` is a no-op |
| `biographies.handle` updated with same value | `WHEN NEW.handle != OLD.handle` guard skips redundant work |
| Case-only handle change (e.g. `Foo` → `foo`) | Trigger fires; `lower()` match updates all case-variants of video handles |

## Validation

```bash
cd /home/william/Downloads/Genesis/src-tauri
cargo check
```

Manual smoke test (optional): create a temp DB, insert a biography + video
with matching handle, `UPDATE biographies SET handle = 'new_handle' WHERE handle = 'old_handle'`,
verify `videos.handle` cascaded.
