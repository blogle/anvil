# Offline controller database compaction

Use this runbook to reclaim space from an existing `controller.sqlite3` whose change
table has already grown large. **Do not run while anvild or any other SQLite writer is
active.** Startup deliberately does not run `VACUUM`.

1. Stop the Anvil service and verify no process has the database open for writing.
2. Make a filesystem-level backup of `controller.sqlite3` and its `-wal`/`-shm` files
   (or use SQLite's online backup API before stopping the service). Keep the backup until
   the compacted database has been validated in service.
3. With the service stopped, checkpoint and close SQLite cleanly:

   ```sh
   sqlite3 /var/lib/anvil/controller.sqlite3 'PRAGMA wal_checkpoint(TRUNCATE);'
   ```

4. Confirm the retention migration exists, then trim only the event log to the latest
   10,000 records. Materializations and durable task/attempt state are not touched:

   ```sh
   sqlite3 /var/lib/anvil/controller.sqlite3 <<'SQL'
   BEGIN IMMEDIATE;
   DELETE FROM orchestration_changes
    WHERE sequence < (SELECT COALESCE(MAX(sequence), 0) - 9999 FROM orchestration_changes);
   UPDATE orchestration_change_retention
      SET floor_sequence = MAX(floor_sequence,
          COALESCE((SELECT MIN(sequence) FROM orchestration_changes) - 1,
                   (SELECT COALESCE(MAX(sequence), 0) FROM orchestration_changes)))
    WHERE singleton = 1;
   COMMIT;
   SQL
   ```

5. Build a separate compacted database, validate it, then swap it in while writers remain
   stopped. `VACUUM INTO` creates a consistent standalone database; never overwrite the
   source file in place.

   ```sh
   sqlite3 /var/lib/anvil/controller.sqlite3 \
     "VACUUM INTO '/var/lib/anvil/controller.sqlite3.compacted';"
   test "$(sqlite3 /var/lib/anvil/controller.sqlite3.compacted 'PRAGMA integrity_check;')" = ok
   mv /var/lib/anvil/controller.sqlite3 /var/lib/anvil/controller.sqlite3.precompact
   mv /var/lib/anvil/controller.sqlite3.compacted /var/lib/anvil/controller.sqlite3
   ```

6. Start Anvil and verify readiness, session listing, and `/v1/changes` reset/snapshot
   behavior. Keep the pre-compaction database and backup until verification succeeds.
   Restore the pre-compaction database (with its matching WAL state) if validation fails.

Old change cursors intentionally return `reset_required`; clients must fetch a full
snapshot. AUTOINCREMENT sequence state and the retention floor survive restart/compaction.
The separate `history.jsonl` stores prompt/lifecycle activity events used by session
activity responses and is retained without modification by this operation.
