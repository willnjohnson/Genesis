/*
OVERVIEW OF CHANGES (mainly table names changed to new mixed-case convention)

Prior	      (changed to)	       Now
------------------------TABLES------------------------------
settings                ==> Settings
glossary                ==> Glossary (now also carries drives directly; glossary_drives is gone)
stop_words              ==> StopWords
custom_prompts          ==> CustomPrompts
search_history          ==> SearchHistory
sync_items              ==> SyncItems
sync_policy             ==> SyncPolicy
workspace_labels        ==> WorkspaceLabels
attachment_blobs        ==> AttachmentBlobs
biographies             ==> Biographies
tblWDBS                 ==> tblWDBS
videos                  ==> Videos
video_wdbs_links        ==> VideoWDBSLinks
video_attachments       ==> VideoAttachments
video_notes             ==> VideoNotes
ftsVideos               ==> ftsVideos

------------------INDEXES ON RENAMED TABLES----------------------
idx_biographies_handle_lower  ==> idxBiographiesHandleLower
idxVideosViewCount            ==> idxVideosViewCount
idxVideosPublishedAt          ==> idxVideosPublishedAt
idxVideosDateAdded            ==> idxVideosDateAdded
idxVideosHandle               ==> idxVideosHandle
— ?                           ==> idxVideoAttachmentsVideoID

----------------TRIGGERS ON RENAMED TABLES----------------------
trgWDBS_BeforeDEL_WDBS_CascadeSafeOrphans        ==> (unchanged)
trgWDBS_BeforeUPD_Videos_MergeValidate           ==> (unchanged)
trgWDBSAfterINS_WDBS_SyncWDInfo                  ==> (unchanged)
trgWDBSAfterUPD_WDBS_SyncWDInfo                  ==> (unchanged)
trgBiographiesAfterUPD_Videos_SyncVideosHandle   ==> (unchanged)
trgVideosAfterDEL_Biographies_PurgeOphanBio      ==> (unchanged)
trgVideosBeforeINS_Videos_ValidateWDBS           ==> (unchanged)
trgVideosBeforeINS_Videos_SyncBioHandle          ==> (unchanged)
trgVideosBeforeUPD_Videos_ValidateWDBS           ==> (unchanged)
trgVideosBeforeDEL_ftsVideos_DeleteTokens        ==> (unchanged)
trgVideosAfterINS_ftsVideos_InsertTokens         ==> (unchanged)
trgVideosAfterUPD_ftsVideos_UpdateTokens         ==> (unchanged)
trgVideosAfterDEL_video_wdbs_links_RemoveRecords ==> trgVideosAfterDEL_VideoWDBSLinks_CascadeDelete
trgKinesis ....                                  ==> trgVideosAfterDEL_Attachments_CascadeDelete

-----------------SPECIAL CONSIDERATIONS ------------------------
You will need to change some internal Kinesis SQL code to reflect the above table name changes.

The "tokenization SQL code" in Kinesis should now reference the TABLE named Videos (table formerly named videos).

Also, the column named "Cull" is now "cull" to meet the "lowercase/camelcase column-name convention" -- it only appears in the StopWords TABLE (table formerly named stop_words).

As before, the column named WDBS is an exception to the column-name convention: this column is always in UPPERCASE across all tables.

The table named tblWDBS was kept as "tblWDBS" because it contains a column named WDBS which might cause an arcane bug (eventually, at least) with both table name and a column name being identical.
*/

CREATE TABLE tblWDBS (
    WDBS TEXT NOT NULL,
    lev INTEGER NOT NULL,
    WDID TEXT NOT NULL,
    WDInfo TEXT NOT NULL,
    WDDefault INTEGER DEFAULT (0) NOT NULL,
    WDIcon TEXT NOT NULL DEFAULT '',
    CONSTRAINT tblWDBS_PK PRIMARY KEY (WDBS),
    CONSTRAINT tblWDBS_upper CHECK (WDBS = UPPER(WDBS))
) STRICT;

CREATE TABLE Videos (
	video_id TEXT NOT NULL,
	title TEXT,
	author TEXT,
	handle TEXT NOT NULL CHECK(handle <> ''),
	length_seconds INTEGER CHECK(length_seconds >= 0),
	transcript TEXT,
	summary TEXT,
	WDBS TEXT NOT NULL DEFAULT('θψ'),
	fkWDBS TEXT GENERATED ALWAYS AS (REPLACE(REPLACE(WDBS, 'θψ', ':'), '_', '-')) STORED,
	view_count INTEGER DEFAULT (0),
	published_at TEXT,
	date_added TEXT DEFAULT (CURRENT_TIMESTAMP),
	tags TEXT DEFAULT (''),
	tokens TEXT DEFAULT (''),
	CONSTRAINT VIDEOS_PK PRIMARY KEY (video_id),
	FOREIGN KEY (fkWDBS) REFERENCES tblWDBS(WDBS) ON DELETE RESTRICT
) STRICT;

CREATE TABLE Glossary (
	term TEXT NOT NULL,
	definition TEXT NOT NULL,
	drives TEXT NOT NULL DEFAULT (''),
	CONSTRAINT GLOSSARY_PK PRIMARY KEY (term)
) STRICT;

CREATE TABLE Biographies (
        handle TEXT NOT NULL,
	channel_id TEXT NOT NULL,
	subscriber_count INTEGER,
	display_name TEXT DEFAULT ('') NOT NULL,
	bio TEXT DEFAULT ('') NOT NULL,
	wikipedia TEXT DEFAULT ('') NOT NULL,
	website TEXT DEFAULT ('') NOT NULL,
	twitter TEXT DEFAULT ('') NOT NULL,
	instagram TEXT DEFAULT ('') NOT NULL,
	facebook TEXT DEFAULT ('') NOT NULL,
	threads TEXT DEFAULT ('') NOT NULL,
	youtube TEXT DEFAULT ('') NOT NULL,
	tiktok TEXT DEFAULT ('') NOT NULL,
	twitch TEXT DEFAULT ('') NOT NULL,
	reddit TEXT DEFAULT ('') NOT NULL,
	discord TEXT DEFAULT ('') NOT NULL,
	CONSTRAINT BIOGRAPHIES_PK PRIMARY KEY (handle)
) STRICT;

CREATE TABLE DriveSequence (
    drive    TEXT NOT NULL,
    video_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (drive, video_id)
) STRICT;

CREATE TABLE SyncItems (
    kind         TEXT NOT NULL,
    item_key     TEXT NOT NULL,
    rev          INTEGER NOT NULL DEFAULT 0,
    content_hash TEXT NOT NULL DEFAULT '',
    synced_at    TEXT DEFAULT (CURRENT_TIMESTAMP),
    seen         INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (kind, item_key)
) STRICT;

CREATE TABLE SyncPolicy (
    key    TEXT NOT NULL PRIMARY KEY,
    value  TEXT NOT NULL,
    locked INTEGER NOT NULL DEFAULT 1
) STRICT;

CREATE TABLE VideoAttachments (
    id INTEGER PRIMARY KEY,
    video_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL,
    hash TEXT NOT NULL,
    added_at TEXT NOT NULL
) STRICT;

CREATE TABLE WorkspaceLabels (
    key   TEXT NOT NULL PRIMARY KEY,
    value TEXT NOT NULL
) STRICT;

CREATE TABLE VideoNotes (
    video_id TEXT NOT NULL PRIMARY KEY,
    note TEXT NOT NULL,
    updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE VideoWDBSLinks (
    video_id TEXT NOT NULL,
    WDBS     TEXT NOT NULL,
    PRIMARY KEY (video_id, WDBS)
) STRICT;

CREATE TABLE AttachmentBlobs (
    hash TEXT NOT NULL PRIMARY KEY,
    compression TEXT NOT NULL DEFAULT 'none',
    size INTEGER NOT NULL,
    stored_size INTEGER NOT NULL,
    data BLOB NOT NULL
) STRICT;

CREATE TABLE CustomPrompts (
    handle TEXT NOT NULL PRIMARY KEY,
    local_prompt_text TEXT,
    cloud_prompt_text TEXT
) STRICT;

CREATE TABLE SearchHistory (
	id	INTEGER PRIMARY KEY,
	search_query	TEXT NOT NULL,
	searched_at	TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
	UNIQUE(search_query)
) STRICT;

CREATE TABLE Settings (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT
) STRICT;

CREATE TABLE StopWords (
	culls TEXT NOT NULL,
	CONSTRAINT pkStopWords PRIMARY KEY (culls)
) STRICT;

CREATE INDEX idxVideosViewCount ON Videos(view_count);
CREATE INDEX idxVideosPublishedAt ON Videos(published_at);
CREATE INDEX idxVideosDateAdded ON Videos(date_added);
CREATE INDEX idxVideosHandle ON Videos(handle);
CREATE INDEX idxVideoAttachmentsVideoID ON VideoAttachments(video_id);
CREATE INDEX idxVideosTags ON Videos(tags);
CREATE INDEX idxVideosWDBS ON Videos(WDBS);
CREATE INDEX idxDriveSequenceOrder ON DriveSequence(drive, position);
CREATE INDEX idxDriveSequenceVideo ON DriveSequence(video_id);
CREATE UNIQUE INDEX idxBiographiesHandleLower ON Biographies(LOWER(handle));

CREATE VIRTUAL TABLE ftsVideos USING fts5(
    title,
    summary,
    tokens,
    WDBS,
    content='Videos'
);

CREATE TRIGGER trgWDBS_BeforeUPD_Videos_MergeValidate
BEFORE UPDATE OF WDBS ON tblWDBS
FOR EACH ROW
WHEN OLD.WDBS != NEW.WDBS
BEGIN
    -- Validate that the target WDBS already exists in tblWDBS
    SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM tblWDBS WHERE WDBS = NEW.WDBS)
        THEN RAISE(ABORT, 'Value must already exist in Warp Drive to permit WDBS change.')
    END;

    -- Propagate the change to all related videos
    UPDATE Videos
    SET WDBS = REPLACE(REPLACE(NEW.WDBS, ':', 'θψ'), '-', '_')
    WHERE WDBS = REPLACE(REPLACE(OLD.WDBS, ':', 'θψ'), '-', '_');

    -- Cancel the original UPDATE (target row already exists, would violate PK)
    SELECT RAISE(IGNORE);
END;

CREATE TRIGGER trgBiographiesAfterUPD_Videos_SyncVideosHandle
AFTER UPDATE OF handle ON Biographies
WHEN NEW.handle != OLD.handle
BEGIN
    -- Update all videos with the old handle to the new handle
    UPDATE Videos
    SET handle = NEW.handle
    WHERE LOWER(handle) = LOWER(OLD.handle);
END;

CREATE TRIGGER trgVideosBeforeINS_Videos_ValidateWDBS
BEFORE INSERT ON Videos
WHEN NEW.WDBS IS NOT NULL
BEGIN
    SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM tblWDBS WHERE WDBS = REPLACE(REPLACE(NEW.WDBS, 'θψ', ':'), '_', '-'))
        THEN RAISE(ABORT, 'Referential integrity violation: WDBS value not found in Warp Drive')
    END;
END;

CREATE TRIGGER trgVideosAfterDEL_VideoWDBSLinks_CascadeDelete
AFTER DELETE ON Videos
BEGIN
    DELETE FROM VideoWDBSLinks WHERE video_id = OLD.video_id;
END;

CREATE TRIGGER trgVideosAfterINS_ftsVideos_InsertTokens
AFTER INSERT ON Videos
BEGIN
    INSERT INTO ftsVideos(rowid, title, summary, tokens, WDBS)
    VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.tokens, NEW.WDBS);
END;

CREATE TRIGGER trgVideosBeforeDEL_ftsVideos_DeleteTokens
BEFORE DELETE ON Videos
BEGIN
    -- Remove from FTS index (recommended in BEFORE DELETE)
    INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, WDBS)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.tokens, OLD.WDBS);
END;

CREATE TRIGGER trgVideosAfterUPD_ftsVideos_UpdateTokens
AFTER UPDATE ON Videos
BEGIN
    INSERT INTO ftsVideos(ftsVideos, rowid, title, summary, tokens, WDBS)
    VALUES ('delete', OLD.rowid, OLD.title, OLD.summary, OLD.tokens, OLD.WDBS);
    INSERT INTO ftsVideos(rowid, title, summary, tokens, WDBS)
    VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.tokens, NEW.WDBS);
END;

CREATE TRIGGER trgVideosBeforeINS_Videos_SyncBioHandle
BEFORE INSERT ON Videos
BEGIN
    -- Check if there's a matching handle in biographies
    INSERT INTO Videos(handle, video_id, title, author, length_seconds, transcript, summary, WDBS, view_count, published_at, date_added, tags, tokens)
    SELECT
        (SELECT handle FROM Biographies
         WHERE lower(Biographies.handle) = lower(NEW.handle)
         LIMIT 1),
        NEW.video_id,
        NEW.title,
        NEW.author,
        NEW.length_seconds,
        NEW.transcript,
        NEW.summary,
        CASE
            WHEN NEW.WDBS IS NOT NULL AND NEW.WDBS != '' AND NEW.WDBS != 'θψ' THEN NEW.WDBS
            WHEN (
                SELECT COUNT(DISTINCT SUBSTR(WDBS, 1, INSTR(WDBS, '_') + INSTR(SUBSTR(WDBS, INSTR(WDBS, '_') + 1), '_') - 1) || '_PND')
                FROM Videos
                WHERE handle = (SELECT handle FROM Biographies WHERE lower(Biographies.handle) = lower(NEW.handle) LIMIT 1)
                AND WDBS GLOB '*_*_*'
            ) = 1 THEN (
                SELECT DISTINCT SUBSTR(WDBS, 1, INSTR(WDBS, '_') + INSTR(SUBSTR(WDBS, INSTR(WDBS, '_') + 1), '_') - 1) || '_PND'
                FROM Videos
                WHERE handle = (SELECT handle FROM Biographies WHERE lower(Biographies.handle) = lower(NEW.handle) LIMIT 1)
                AND WDBS GLOB '*_*_*'
                LIMIT 1
            )
            ELSE 'θψ'
        END,
        NEW.view_count,
        NEW.published_at,
        NEW.date_added,
        NEW.tags,
        NEW.tokens
    WHERE EXISTS (
        SELECT 1 FROM Biographies
        WHERE lower(Biographies.handle) = lower(NEW.handle)
    );

    -- If no match exists, use the original handle
    INSERT INTO Videos(handle, video_id, title, author, length_seconds, transcript, summary, WDBS, view_count, published_at, date_added, tags, tokens)
    SELECT
        NEW.handle,
        NEW.video_id,
        NEW.title,
        NEW.author,
        NEW.length_seconds,
        NEW.transcript,
        NEW.summary,
        CASE
            WHEN NEW.WDBS IS NOT NULL AND NEW.WDBS != '' AND NEW.WDBS != 'θψ' THEN NEW.WDBS
            WHEN (
                SELECT COUNT(DISTINCT SUBSTR(WDBS, 1, INSTR(WDBS, '_') + INSTR(SUBSTR(WDBS, INSTR(WDBS, '_') + 1), '_') - 1) || '_PND')
                FROM Videos
                WHERE handle = NEW.handle
                AND WDBS GLOB '*_*_*'
            ) = 1 THEN (
                SELECT DISTINCT SUBSTR(WDBS, 1, INSTR(WDBS, '_') + INSTR(SUBSTR(WDBS, INSTR(WDBS, '_') + 1), '_') - 1) || '_PND'
                FROM Videos
                WHERE handle = NEW.handle
                AND WDBS GLOB '*_*_*'
                LIMIT 1
            )
            ELSE 'θψ'
        END,
        NEW.view_count,
        NEW.published_at,
        NEW.date_added,
        NEW.tags,
        NEW.tokens
    WHERE NOT EXISTS (
        SELECT 1 FROM Biographies
        WHERE lower(Biographies.handle) = lower(NEW.handle)
    );

    -- Cancel the original INSERT
    SELECT RAISE(IGNORE);
END;

CREATE TRIGGER trgWDBS_BeforeDEL_WDBS_CascadeSafeOrphans
BEFORE DELETE ON tblWDBS
FOR EACH ROW
BEGIN
    -- Block Lev 0 (root) deletion entirely
    SELECT CASE
        WHEN OLD.lev = 0
            THEN RAISE(ABORT, 'Cannot delete root WDBS (Lev 0)')
    END;

    -- Block unsafe Lev 4 target (referenced by videos)
    SELECT CASE
        WHEN OLD.lev = 4 AND EXISTS (SELECT 1 FROM videos WHERE fkWDBS = OLD.WDBS)
            THEN RAISE(ABORT, 'Cannot delete Lev 4 WDBS still referenced by videos')
    END;

    -- Block unsafe Lev 3 target (referenced by videos)
    SELECT CASE
        WHEN OLD.lev = 3 AND EXISTS (SELECT 1 FROM videos WHERE fkWDBS = OLD.WDBS)
            THEN RAISE(ABORT, 'Cannot delete Lev 3 WDBS still referenced by videos')
    END;

    -- Step 1: Cascade-delete safe Lev 4 descendants (not referenced by videos)
    DELETE FROM tblWDBS
    WHERE lev = 4
      AND WDBS LIKE OLD.WDBS || '-%'
      AND NOT EXISTS (SELECT 1 FROM Videos WHERE fkWDBS = tblWDBS.WDBS);

    -- Step 2: Cascade-delete safe Lev 3 descendants.
    -- A Lev 3 row is safe to delete if BOTH:
    --   (a) NOT referenced by videos directly, AND
    --   (b) has NO surviving Lev 4 children (after Step 1)
    -- If either condition fails, the Lev 3 row survives.
    DELETE FROM tblWDBS
    WHERE lev = 3
      AND WDBS LIKE OLD.WDBS || '-%'
      AND NOT EXISTS (SELECT 1 FROM Videos WHERE fkWDBS = tblWDBS.WDBS)
      AND NOT EXISTS (
          SELECT 1 FROM tblWDBS child
          WHERE child.lev = 4
            AND child.WDBS LIKE tblWDBS.WDBS || '-%'
      );

    -- Step 3: Cascade-delete Lev 2 descendants with no remaining Lev 3 children.
    DELETE FROM tblWDBS
    WHERE lev = 2
      AND WDBS LIKE OLD.WDBS || '-%'
      AND NOT EXISTS (
          SELECT 1 FROM tblWDBS child
          WHERE child.lev = 3
            AND child.WDBS LIKE tblWDBS.WDBS || '-%'
      );

    -- Step 4: If ANY descendant survives the cascade, the target must survive.
    -- After Steps 1-3, any surviving descendant is unsafe (either directly
    -- referenced by videos at Lev 3/4, or shielded by unsafe children).
    -- RAISE(FAIL) rolls back the triggering DELETE but preserves cascade deletes.
    SELECT CASE
        WHEN OLD.lev IN (1, 2, 3) AND EXISTS (
            SELECT 1 FROM tblWDBS
            WHERE WDBS LIKE OLD.WDBS || '-%'
        )
            THEN RAISE(FAIL, 'WDBS not deleted: some subordinate entries are referenced by videos')
    END;
END;

CREATE TRIGGER trgWDBSAfterINS_WDBS_SyncWDInfo
AFTER INSERT ON tblWDBS
FOR EACH ROW
WHEN NEW.lev = 3
    AND EXISTS (
        SELECT 1 FROM tblWDBS
        WHERE WDID = NEW.WDID
          AND rowid != NEW.rowid
    )
BEGIN
    UPDATE tblWDBS
    SET WDInfo = (
        SELECT WDInfo FROM tblWDBS
        WHERE WDID = NEW.WDID
          AND rowid != NEW.rowid
        LIMIT 1
    )
    WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trgWDBSAfterUPD_WDBS_SyncWDInfo
AFTER UPDATE OF WDID ON tblWDBS
FOR EACH ROW
WHEN NEW.lev = 3
    AND NEW.WDID != OLD.WDID
    AND EXISTS (
        SELECT 1 FROM tblWDBS
        WHERE WDID = NEW.WDID
          AND rowid != NEW.rowid
    )
BEGIN
    UPDATE tblWDBS
    SET WDInfo = (
        SELECT WDInfo FROM tblWDBS
        WHERE WDID = NEW.WDID
          AND rowid != NEW.rowid
        LIMIT 1
    )
    WHERE rowid = NEW.rowid;
END;

CREATE TRIGGER trgVideosAfterDEL_Attachments_CascadeDelete
        AFTER DELETE ON Videos
        BEGIN
            DELETE FROM VideoNotes WHERE video_id = OLD.video_id;
            DELETE FROM VideoAttachments WHERE video_id = OLD.video_id;
            DELETE FROM AttachmentBlobs WHERE hash NOT IN (SELECT hash FROM VideoAttachments);
END;

CREATE TRIGGER trgVideosAfterDEL_DriveSequence_CascadeDelete
        AFTER DELETE ON Videos
        BEGIN
            DELETE FROM DriveSequence WHERE video_id = OLD.video_id;
END;

CREATE TRIGGER trgVideosBeforeUPD_Videos_ValidateWDBS
BEFORE UPDATE ON Videos
WHEN NEW.WDBS IS NOT NULL AND NEW.WDBS != OLD.WDBS
BEGIN
    SELECT CASE
        WHEN NOT EXISTS (SELECT 1 FROM tblWDBS WHERE WDBS = REPLACE(REPLACE(NEW.WDBS, 'θψ', ':'), '_', '-'))
        THEN RAISE(ABORT, 'Referential integrity violation: WDBS value not found in Warp Drive')
    END;
END;

CREATE TRIGGER trgVideosAfterDEL_Biographies_PurgeOphanBio
AFTER DELETE ON Videos
BEGIN
    -- Delete biography entry if this is the last video with this handle
    DELETE FROM Biographies
    WHERE LOWER(Biographies.handle) = LOWER(OLD.handle)
    AND OLD.handle IS NOT NULL
    AND (SELECT COUNT(*) FROM Videos
         WHERE LOWER(Videos.handle) = LOWER(OLD.handle)) = 0;
END;
