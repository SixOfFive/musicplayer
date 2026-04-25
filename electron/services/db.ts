import Database from 'better-sqlite3';
import { getSettings } from './settings-store';

let db: Database.Database | null = null;

export async function initDatabase(): Promise<void> {
  const { databasePath } = getSettings().library;
  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS directories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_scanned_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS artists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      artist_id INTEGER REFERENCES artists(id),
      year INTEGER,
      genre TEXT,
      cover_art_path TEXT,
      UNIQUE(title, artist_id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist_id INTEGER REFERENCES artists(id),
      album_id INTEGER REFERENCES albums(id),
      album_artist TEXT,
      track_no INTEGER,
      disc_no INTEGER,
      year INTEGER,
      genre TEXT,
      duration_sec REAL,
      bitrate INTEGER,
      sample_rate INTEGER,
      codec TEXT,
      mtime INTEGER,
      size INTEGER,
      date_added INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_title ON tracks(title);

    -- Liked songs: a boolean flag per track. The "Liked Songs" master playlist
    -- is materialised at query time from WHERE liked = 1.
    CREATE TABLE IF NOT EXISTS track_likes (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      liked_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      kind TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'smart'
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, track_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pl_tracks_order ON playlist_tracks(playlist_id, position);

    -- Per-track rollup: fast lookups for "most played", "last played", etc.
    -- Denormalized copy of aggregates from play_events so we don't re-scan the
    -- events table on every stats query. Updated on each record-play IPC.
    CREATE TABLE IF NOT EXISTS track_plays_summary (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      play_count INTEGER NOT NULL DEFAULT 0,
      last_played_at INTEGER,
      total_listened_sec REAL NOT NULL DEFAULT 0
    );

    -- Individual play events — needed for time-series (hours-per-day/week/month/year,
    -- listening streaks, time-of-day histograms, session-length stats).
    -- Recorded whenever a track finishes or is skipped with >= 5 sec heard.
    CREATE TABLE IF NOT EXISTS play_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      played_at INTEGER NOT NULL,
      listened_sec REAL NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_play_events_time ON play_events(played_at);
    CREATE INDEX IF NOT EXISTS idx_play_events_track ON play_events(track_id);

    -- Lyrics cache per track. Populated lazily when the user opens the
    -- LyricsPanel for a track that doesn't have an entry yet:
    --   1. Check next to the audio file for <basename>.lrc — if present,
    --      load synced lyrics from disk (no network).
    --   2. Else hit LRCLib.net (free, no key) keyed by artist+title+
    --      album+duration.
    --   3. Cache the result here so subsequent plays don't re-fetch.
    --
    --   source: 'local-lrc' | 'lrclib' | 'manual' | 'none'
    --     'none' means we tried and the track has no lyrics anywhere -- kept
    --     so we do not re-poll LRCLib on every play of the same track.
    --   synced_text: raw LRC body with [mm:ss.cc] timestamps. Null if only
    --     plain lyrics exist (LRCLib returns both fields independently).
    --   plain_text: untimestamped fallback. Always populated when synced
    --     is -- derived by stripping timestamps. Used as the display when
    --     the user has timed-highlight disabled.
    CREATE TABLE IF NOT EXISTS track_lyrics (
      track_id INTEGER PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      synced_text TEXT,
      plain_text TEXT,
      fetched_at INTEGER NOT NULL
    );
  `);

  // Lightweight migrations for existing databases (idempotent).
  const cols = db.prepare("PRAGMA table_info(albums)").all() as Array<{ name: string }>;
  if (!cols.find((c) => c.name === 'genre')) {
    db.exec('ALTER TABLE albums ADD COLUMN genre TEXT');
  }
  if (!cols.find((c) => c.name === 'art_lookup_at')) {
    // Epoch ms when we last consulted online providers for this album's art.
    // Used to skip re-querying albums that have no online match.
    db.exec('ALTER TABLE albums ADD COLUMN art_lookup_at INTEGER');
  }
  if (!cols.find((c) => c.name === 'art_lookup_failed')) {
    // Set to 1 when all enabled providers returned nothing.
    db.exec('ALTER TABLE albums ADD COLUMN art_lookup_failed INTEGER DEFAULT 0');
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized');
  return db;
}
