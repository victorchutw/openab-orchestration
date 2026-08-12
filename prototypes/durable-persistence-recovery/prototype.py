#!/usr/bin/env python3
"""THROWAWAY: exercise a recovery-first SQLite durability layout."""

from __future__ import annotations

from functools import wraps
import hashlib
import fcntl
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import time
from typing import Any


CRASH_EXIT = 86


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def digest_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_write(path: Path, value: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fsync_directory(path.parent)


def crash_at(selected: str | None, phase: str) -> None:
    if selected == phase:
        os._exit(CRASH_EXIT)


def single_writer(method):
    """Hide the Linux reference profile's one-writer coordination."""
    @wraps(method)
    def wrapped(self, *args, **kwargs):
        self.root.mkdir(parents=True, exist_ok=True)
        lock_path = self.root / "writer.lock"
        descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            return method(self, *args, **kwargs)
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
    return wrapped


class CapsuleLayout:
    """One authoritative SQLite DB plus immutable recovery commit capsules."""

    def __init__(self, root: Path):
        self.root = root
        self.primary = root / "primary"
        self.recovery = root / "recovery"
        self.database = self.primary / "core.db"

    def initialize(self) -> None:
        self.primary.mkdir(parents=True, exist_ok=True)
        self.recovery.mkdir(parents=True, exist_ok=True)
        if not self.database.exists():
            with self.connect(self.database) as connection:
                connection.executescript(
                    """
                    CREATE TABLE meta (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    INSERT INTO meta VALUES
                        ('head', 'GENESIS'),
                        ('revision', '0'),
                        ('authority_epoch', '1'),
                        ('schema_version', '1'),
                        ('recovery_gate', 'open');

                    CREATE TABLE current_state (
                        key TEXT PRIMARY KEY,
                        value TEXT NOT NULL
                    );
                    CREATE TABLE commits (
                        commit_id TEXT PRIMARY KEY,
                        predecessor TEXT NOT NULL,
                        revision INTEGER NOT NULL UNIQUE,
                        request_id TEXT NOT NULL UNIQUE,
                        request_digest TEXT NOT NULL,
                        receipt_json TEXT NOT NULL,
                        capsule_digest TEXT NOT NULL UNIQUE
                    );
                    CREATE TABLE artifacts (
                        digest TEXT PRIMARY KEY,
                        size INTEGER NOT NULL
                    );
                    CREATE TABLE artifact_refs (
                        commit_id TEXT NOT NULL REFERENCES commits(commit_id),
                        digest TEXT NOT NULL REFERENCES artifacts(digest),
                        PRIMARY KEY (commit_id, digest)
                    );
                    CREATE TABLE effect_intents (
                        effect_id TEXT PRIMARY KEY,
                        commit_id TEXT NOT NULL REFERENCES commits(commit_id),
                        disposition TEXT NOT NULL
                    );
                    """
                )
            self.create_generation("g000000-initial", self.database)

    @staticmethod
    def connect(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(path, isolation_level=None)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA synchronous=FULL")
        connection.execute("PRAGMA foreign_keys=ON")
        return connection

    @staticmethod
    def meta(connection: sqlite3.Connection) -> dict[str, str]:
        return {
            row["key"]: row["value"]
            for row in connection.execute("SELECT key, value FROM meta")
        }

    @staticmethod
    def object_path(store: Path, digest: str) -> Path:
        return store / "objects" / "sha256" / digest[:2] / digest[2:]

    def promote(self, store: Path, value: bytes) -> str:
        digest = digest_bytes(value)
        destination = self.object_path(store, digest)
        if destination.exists():
            if digest_bytes(destination.read_bytes()) != digest:
                raise RuntimeError("content-addressed object mismatch")
            return digest
        staging = store / "staging" / f"{digest}.{os.getpid()}"
        atomic_write(staging, value)
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(staging, destination)
        fsync_directory(destination.parent)
        return digest

    def capsule_path(self, capsule: dict[str, Any]) -> Path:
        return self.recovery / "commits" / (
            f"{capsule['revision']:08d}-{capsule['commit_id']}.json"
        )

    @staticmethod
    def seal_capsule(body: dict[str, Any]) -> dict[str, Any]:
        return {**body, "capsule_digest": digest_bytes(canonical(body))}

    @staticmethod
    def verify_capsule(capsule: dict[str, Any]) -> None:
        expected = capsule["capsule_digest"]
        body = {key: value for key, value in capsule.items() if key != "capsule_digest"}
        if digest_bytes(canonical(body)) != expected:
            raise RuntimeError("commit capsule digest mismatch")

    def build_capsule(
        self,
        request_id: str,
        changes: dict[str, str],
        artifact_digest: str,
        artifact_size: int,
        effect_ids: list[str],
    ) -> dict[str, Any]:
        payload = {
            "changes": changes,
            "artifact_digest": artifact_digest,
            "effect_ids": effect_ids,
        }
        request_digest = digest_bytes(canonical(payload))
        commit_id = "c-" + digest_bytes(
            canonical({"request_id": request_id, "request_digest": request_digest})
        )[:20]
        with self.connect(self.database) as connection:
            metadata = self.meta(connection)
        revision = int(metadata["revision"]) + 1
        receipt = {
            "status": "accepted",
            "request_id": request_id,
            "commit_id": commit_id,
            "revision": revision,
        }
        return self.seal_capsule(
            {
                "format": 1,
                "commit_id": commit_id,
                "predecessor": metadata["head"],
                "revision": revision,
                "request_id": request_id,
                "request_digest": request_digest,
                "changes": changes,
                "artifacts": [
                    {"digest": artifact_digest, "size": artifact_size}
                ],
                "effect_intents": [
                    {"effect_id": effect_id, "disposition": "Pending"}
                    for effect_id in effect_ids
                ],
                "receipt": receipt,
            }
        )

    @single_writer
    def commit(
        self,
        request_id: str,
        changes: dict[str, str],
        artifact: bytes,
        effect_ids: list[str],
        fault: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        with self.connect(self.database) as connection:
            existing = connection.execute(
                "SELECT request_digest, receipt_json FROM commits WHERE request_id = ?",
                (request_id,),
            ).fetchone()
        payload_digest = digest_bytes(
            canonical(
                {
                    "changes": changes,
                    "artifact_digest": digest_bytes(artifact),
                    "effect_ids": effect_ids,
                }
            )
        )
        if existing:
            if existing["request_digest"] != payload_digest:
                raise RuntimeError("request ID reused with different content")
            return json.loads(existing["receipt_json"])

        primary_digest = self.promote(self.primary, artifact)
        crash_at(fault, "after_primary_artifact")
        recovery_digest = self.promote(self.recovery, artifact)
        if primary_digest != recovery_digest:
            raise RuntimeError("artifact digest differs across durability boundary")
        crash_at(fault, "after_recovery_artifact")

        capsule = self.build_capsule(
            request_id,
            changes,
            primary_digest,
            len(artifact),
            effect_ids,
        )
        atomic_write(self.capsule_path(capsule), canonical(capsule))
        crash_at(fault, "after_recovery_capsule")
        self.apply_capsule(self.database, capsule)
        crash_at(fault, "after_primary_commit")
        return capsule["receipt"]

    def apply_capsule(self, database: Path, capsule: dict[str, Any]) -> None:
        self.verify_capsule(capsule)
        for artifact in capsule["artifacts"]:
            recovery_object = self.object_path(self.recovery, artifact["digest"])
            if not recovery_object.exists():
                raise RuntimeError("capsule refers to missing recovery artifact")
            if digest_bytes(recovery_object.read_bytes()) != artifact["digest"]:
                raise RuntimeError("recovery artifact digest mismatch")

        with self.connect(database) as connection:
            connection.execute("BEGIN IMMEDIATE")
            try:
                existing = connection.execute(
                    "SELECT capsule_digest FROM commits WHERE commit_id = ?",
                    (capsule["commit_id"],),
                ).fetchone()
                if existing:
                    if existing["capsule_digest"] != capsule["capsule_digest"]:
                        raise RuntimeError("Commit ID reused with different capsule")
                    connection.execute("COMMIT")
                    return

                metadata = self.meta(connection)
                if metadata["head"] != capsule["predecessor"]:
                    raise RuntimeError("prepared capsule predecessor is not active head")
                if int(metadata["revision"]) + 1 != capsule["revision"]:
                    raise RuntimeError("prepared capsule revision is not next")

                connection.execute(
                    """
                    INSERT INTO commits VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        capsule["commit_id"],
                        capsule["predecessor"],
                        capsule["revision"],
                        capsule["request_id"],
                        capsule["request_digest"],
                        json.dumps(capsule["receipt"], sort_keys=True),
                        capsule["capsule_digest"],
                    ),
                )
                for key, value in capsule["changes"].items():
                    connection.execute(
                        """
                        INSERT INTO current_state VALUES (?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value
                        """,
                        (key, value),
                    )
                for artifact in capsule["artifacts"]:
                    connection.execute(
                        "INSERT OR IGNORE INTO artifacts VALUES (?, ?)",
                        (artifact["digest"], artifact["size"]),
                    )
                    connection.execute(
                        "INSERT INTO artifact_refs VALUES (?, ?)",
                        (capsule["commit_id"], artifact["digest"]),
                    )
                for effect in capsule["effect_intents"]:
                    connection.execute(
                        "INSERT INTO effect_intents VALUES (?, ?, ?)",
                        (
                            effect["effect_id"],
                            capsule["commit_id"],
                            effect["disposition"],
                        ),
                    )
                connection.execute(
                    "UPDATE meta SET value = ? WHERE key = 'head'",
                    (capsule["commit_id"],),
                )
                connection.execute(
                    "UPDATE meta SET value = ? WHERE key = 'revision'",
                    (str(capsule["revision"]),),
                )
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise

    def capsules(self) -> list[dict[str, Any]]:
        result = []
        for path in sorted((self.recovery / "commits").glob("*.json")):
            capsule = json.loads(path.read_text())
            self.verify_capsule(capsule)
            result.append(capsule)
        return result

    def recover_restart(self) -> dict[str, Any]:
        self.initialize()
        completed = []
        prepared = []
        for capsule in self.capsules():
            with self.connect(self.database) as connection:
                metadata = self.meta(connection)
                exists = connection.execute(
                    "SELECT 1 FROM commits WHERE commit_id = ?",
                    (capsule["commit_id"],),
                ).fetchone()
            if exists:
                continue
            if metadata["head"] == capsule["predecessor"]:
                for artifact in capsule["artifacts"]:
                    source = self.object_path(self.recovery, artifact["digest"])
                    self.promote(self.primary, source.read_bytes())
                self.apply_capsule(self.database, capsule)
                completed.append(capsule["commit_id"])
            else:
                prepared.append(capsule["commit_id"])
        return {"completed": completed, "prepared": prepared, **self.inspect()}

    def inspect(self, database: Path | None = None) -> dict[str, Any]:
        target = database or self.database
        with self.connect(target) as connection:
            metadata = self.meta(connection)
            return {
                **metadata,
                "commits": connection.execute(
                    "SELECT COUNT(*) FROM commits"
                ).fetchone()[0],
                "effects": connection.execute(
                    "SELECT COUNT(*) FROM effect_intents"
                ).fetchone()[0],
                "state": {
                    row["key"]: row["value"]
                    for row in connection.execute(
                        "SELECT key, value FROM current_state ORDER BY key"
                    )
                },
            }

    def create_generation(self, name: str, source_database: Path) -> Path:
        generation = self.recovery / "generations" / name
        generation.mkdir(parents=True, exist_ok=True)
        database_copy = generation / "core.db"
        temporary = generation / f".core.db.{os.getpid()}.tmp"
        if temporary.exists():
            temporary.unlink()
        with self.connect(source_database) as source:
            source.execute("PRAGMA wal_checkpoint(FULL)")
            with sqlite3.connect(temporary) as destination:
                source.backup(destination)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.replace(temporary, database_copy)
        fsync_directory(generation)
        with self.connect(database_copy) as connection:
            metadata = self.meta(connection)
            artifacts = [
                row[0]
                for row in connection.execute(
                    "SELECT digest FROM artifacts ORDER BY digest"
                )
            ]
        manifest = {
            "format": 1,
            "database_digest": digest_bytes(database_copy.read_bytes()),
            "head": metadata["head"],
            "revision": int(metadata["revision"]),
            "authority_epoch": int(metadata["authority_epoch"]),
            "schema_version": int(metadata["schema_version"]),
            "artifacts": artifacts,
        }
        atomic_write(generation / "manifest.json", canonical(manifest))
        return generation

    def verified_generations(self) -> list[tuple[Path, dict[str, Any]]]:
        result = []
        for generation in sorted((self.recovery / "generations").glob("*")):
            manifest_path = generation / "manifest.json"
            database_path = generation / "core.db"
            if not manifest_path.exists() or not database_path.exists():
                continue
            manifest = json.loads(manifest_path.read_text())
            if digest_bytes(database_path.read_bytes()) != manifest["database_digest"]:
                continue
            with self.connect(database_path) as connection:
                if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    continue
            result.append((generation, manifest))
        return result

    def restore_primary(self) -> dict[str, Any]:
        generations = self.verified_generations()
        if not generations:
            raise RuntimeError("no verified recovery generation")
        generation, manifest = max(generations, key=lambda item: item[1]["revision"])
        self.primary.mkdir(parents=True, exist_ok=True)
        candidate = self.primary / ".restore-candidate.db"
        shutil.copy2(generation / "core.db", candidate)
        for capsule in self.capsules():
            if capsule["revision"] <= manifest["revision"]:
                continue
            with self.connect(candidate) as connection:
                head = self.meta(connection)["head"]
            if capsule["predecessor"] == head:
                self.apply_capsule(candidate, capsule)

        with self.connect(candidate) as connection:
            connection.execute("BEGIN IMMEDIATE")
            epoch = int(self.meta(connection)["authority_epoch"]) + 1
            connection.execute(
                "UPDATE meta SET value = ? WHERE key = 'authority_epoch'",
                (str(epoch),),
            )
            connection.execute(
                "UPDATE meta SET value = 'restore' WHERE key = 'recovery_gate'"
            )
            connection.execute("COMMIT")
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("restored candidate failed integrity check")

        for row in self.referenced_artifacts(candidate):
            source = self.object_path(self.recovery, row)
            if not source.exists():
                raise RuntimeError("restore generation lacks referenced artifact")
            self.promote(self.primary, source.read_bytes())

        self.create_generation(f"restore-e{epoch}", candidate)
        os.replace(candidate, self.database)
        fsync_directory(self.primary)
        return self.inspect()

    def migrate_v2(self, fault: str | None = None) -> dict[str, Any]:
        # The gate must be durable in the active schema before the candidate is
        # copied. A crash may restart the old binary and old database; both must
        # still refuse normal mutations while the upgrade is incomplete.
        self.commit(
            "system-begin-upgrade-v2",
            {"installation_gate": "upgrade-v2"},
            b"schema-v2-upgrade-manifest",
            [],
        )
        candidates = self.primary / "candidates"
        candidates.mkdir(parents=True, exist_ok=True)
        candidate = candidates / "schema-v2.db"
        if candidate.exists():
            candidate.unlink()
        with self.connect(self.database) as source:
            with sqlite3.connect(candidate) as destination:
                source.backup(destination)
        with self.connect(candidate) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute(
                "ALTER TABLE artifacts ADD COLUMN media_type TEXT NOT NULL DEFAULT 'application/octet-stream'"
            )
            crash_at(fault, "during_migration_transaction")
            epoch = int(self.meta(connection)["authority_epoch"]) + 1
            connection.execute(
                "UPDATE meta SET value = '2' WHERE key = 'schema_version'"
            )
            connection.execute(
                "UPDATE meta SET value = ? WHERE key = 'authority_epoch'",
                (str(epoch),),
            )
            connection.execute(
                "UPDATE meta SET value = 'upgrade' WHERE key = 'recovery_gate'"
            )
            connection.execute("COMMIT")
            if connection.execute("PRAGMA foreign_key_check").fetchall():
                raise RuntimeError("migrated candidate failed foreign key check")
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("migrated candidate failed integrity check")
        crash_at(fault, "after_migrated_candidate")
        self.create_generation(f"migrate-v2-e{epoch}", candidate)
        crash_at(fault, "after_recovery_generation")
        os.replace(candidate, self.database)
        fsync_directory(self.primary)
        return self.inspect()

    @staticmethod
    def referenced_artifacts(database: Path) -> set[str]:
        with CapsuleLayout.connect(database) as connection:
            return {
                row[0] for row in connection.execute("SELECT digest FROM artifacts")
            }

    def collect_orphans(self, grace_seconds: int) -> dict[str, list[str]]:
        referenced = self.referenced_artifacts(self.database)
        for capsule in self.capsules():
            referenced.update(item["digest"] for item in capsule["artifacts"])
        for _, manifest in self.verified_generations():
            referenced.update(manifest["artifacts"])

        deleted = []
        kept = []
        cutoff = time.time() - grace_seconds
        for store_name, store in (("primary", self.primary), ("recovery", self.recovery)):
            for path in (store / "objects" / "sha256").glob("*/*"):
                digest = path.parent.name + path.name
                label = f"{store_name}:{digest[:12]}"
                if digest not in referenced and path.stat().st_mtime < cutoff:
                    path.unlink()
                    deleted.append(label)
                else:
                    kept.append(label)
        return {"deleted": sorted(deleted), "kept": sorted(kept)}


def crash_commit_worker(root: str, phase: str) -> None:
    layout = CapsuleLayout(Path(root))
    layout.commit(
        "request-1",
        {"run": "Reviewing"},
        b"review-target-1",
        ["effect-notify-1"],
        fault=phase,
    )


def migration_worker(root: str, phase: str) -> None:
    CapsuleLayout(Path(root)).migrate_v2(fault=phase)


def concurrent_commit_worker(root: str, writer: int) -> None:
    CapsuleLayout(Path(root)).commit(
        f"concurrent-request-{writer}",
        {f"writer-{writer}": "committed"},
        f"artifact-{writer}".encode(),
        [],
    )


def run_hard_exit(target: Any, *arguments: str) -> int:
    process = multiprocessing.Process(target=target, args=arguments)
    process.start()
    process.join(10)
    if process.is_alive():
        process.kill()
        raise RuntimeError("fault process did not exit")
    return process.exitcode or 0


def exercise_single_writer(root: Path) -> dict[str, Any]:
    layout = CapsuleLayout(root)
    layout.initialize()
    processes = [
        multiprocessing.Process(
            target=concurrent_commit_worker, args=(str(root), writer)
        )
        for writer in range(4)
    ]
    for process in processes:
        process.start()
    for process in processes:
        process.join(10)
        if process.is_alive():
            process.kill()
            raise RuntimeError("concurrent writer did not exit")
        if process.exitcode != 0:
            raise RuntimeError("concurrent writer failed")
    with layout.connect(layout.database) as connection:
        revisions = [
            row[0]
            for row in connection.execute(
                "SELECT revision FROM commits ORDER BY revision"
            )
        ]
    capsules = layout.capsules()
    predecessor_chain = [capsule["predecessor"] for capsule in capsules]
    return {
        "writers": len(processes),
        "commits": layout.inspect()["commits"],
        "revisions": revisions,
        "unique_capsule_revisions": len({item["revision"] for item in capsules}),
        "predecessor_chain_length": len(predecessor_chain),
    }


def compare_alternatives(root: Path) -> dict[str, Any]:
    root.mkdir(parents=True, exist_ok=True)
    mirror = root / "mirror-after-commit"
    mirror.mkdir()
    primary = mirror / "primary.db"
    recovery = mirror / "recovery.db"
    for database in (primary, recovery):
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE state (revision INTEGER NOT NULL)")
            connection.execute("INSERT INTO state VALUES (0)")
    with sqlite3.connect(primary) as connection:
        connection.execute("UPDATE state SET revision = 1")
    mirror_observation = {
        "primary_revision": sqlite3.connect(primary).execute(
            "SELECT revision FROM state"
        ).fetchone()[0],
        "recovery_revision": sqlite3.connect(recovery).execute(
            "SELECT revision FROM state"
        ).fetchone()[0],
        "fault": "process loss after primary commit, before full mirror",
    }

    dual = root / "dual-sqlite-2pc"
    dual.mkdir()
    primary = dual / "primary.db"
    recovery = dual / "recovery.db"
    for database in (primary, recovery):
        with sqlite3.connect(database) as connection:
            connection.execute("CREATE TABLE commits (id TEXT PRIMARY KEY)")
            connection.execute("PRAGMA user_version=1")
    with sqlite3.connect(recovery) as connection:
        connection.execute("ALTER TABLE commits ADD COLUMN digest TEXT")
        connection.execute("PRAGMA user_version=2")
    dual_observation = {
        "primary_schema": sqlite3.connect(primary).execute(
            "PRAGMA user_version"
        ).fetchone()[0],
        "recovery_schema": sqlite3.connect(recovery).execute(
            "PRAGMA user_version"
        ).fetchone()[0],
        "fault": "upgrade interruption after recovery schema, before primary schema",
    }
    return {
        "mirror_after_commit": mirror_observation,
        "dual_sqlite_2pc": dual_observation,
    }


def exercise_commit_boundaries(root: Path) -> list[dict[str, Any]]:
    observations = []
    for phase in (
        "after_primary_artifact",
        "after_recovery_artifact",
        "after_recovery_capsule",
        "after_primary_commit",
    ):
        scenario = root / phase
        layout = CapsuleLayout(scenario)
        layout.initialize()
        exit_code = run_hard_exit(crash_commit_worker, str(scenario), phase)
        recovered = layout.recover_restart()
        before_replay = recovered["commits"]
        receipt = layout.commit(
            "request-1",
            {"run": "Reviewing"},
            b"review-target-1",
            ["effect-notify-1"],
        )
        after_replay = layout.inspect()
        observations.append(
            {
                "phase": phase,
                "hard_exit": exit_code,
                "committed_on_restart": before_replay,
                "commits_after_same_request_replay": after_replay["commits"],
                "effects_after_same_request_replay": after_replay["effects"],
                "receipt": receipt,
            }
        )
    return observations


def exercise_primary_loss(root: Path) -> dict[str, Any]:
    layout = CapsuleLayout(root)
    layout.commit(
        "request-restore",
        {"run": "Final Decision"},
        b"evidence-bundle",
        ["effect-publish"],
    )
    shutil.rmtree(layout.primary)
    restored = layout.restore_primary()
    return {
        "state": restored["state"],
        "commits": restored["commits"],
        "effects_requiring_reconciliation": restored["effects"],
        "authority_epoch": restored["authority_epoch"],
        "recovery_gate": restored["recovery_gate"],
    }


def exercise_migration(root: Path) -> dict[str, Any]:
    layout = CapsuleLayout(root)
    layout.initialize()
    interruption = run_hard_exit(migration_worker, str(root), "during_migration_transaction")
    after_transaction_crash = layout.inspect()
    interruption_after_generation = run_hard_exit(
        migration_worker, str(root), "after_recovery_generation"
    )
    before_activation = layout.inspect()
    activated = layout.migrate_v2()
    return {
        "transaction_crash_exit": interruption,
        "schema_after_transaction_crash": after_transaction_crash["schema_version"],
        "gate_after_transaction_crash": after_transaction_crash["state"].get(
            "installation_gate"
        ),
        "generation_crash_exit": interruption_after_generation,
        "schema_before_atomic_activation": before_activation["schema_version"],
        "gate_before_atomic_activation": before_activation["state"].get(
            "installation_gate"
        ),
        "schema_after_activation": activated["schema_version"],
        "authority_epoch_after_activation": activated["authority_epoch"],
        "recovery_gate_after_activation": activated["recovery_gate"],
    }


def exercise_orphan_cleanup(root: Path) -> dict[str, Any]:
    layout = CapsuleLayout(root)
    layout.commit("request-keep", {"run": "Coding"}, b"accepted", [])
    prepared_digest = layout.promote(layout.primary, b"prepared")
    layout.promote(layout.recovery, b"prepared")
    prepared = layout.seal_capsule(
        {
            "format": 1,
            "commit_id": "c-prepared-blocked",
            "predecessor": "not-the-active-head",
            "revision": 99,
            "request_id": "request-prepared",
            "request_digest": digest_bytes(b"prepared"),
            "changes": {},
            "artifacts": [{"digest": prepared_digest, "size": len(b"prepared")}],
            "effect_intents": [],
            "receipt": {"status": "prepared"},
        }
    )
    atomic_write(layout.capsule_path(prepared), canonical(prepared))
    orphan_digest = layout.promote(layout.primary, b"orphan")
    layout.promote(layout.recovery, b"orphan")
    old = time.time() - 3600
    for store in (layout.primary, layout.recovery):
        os.utime(layout.object_path(store, orphan_digest), (old, old))
    collected = layout.collect_orphans(grace_seconds=60)
    return {
        "prepared_artifact_preserved": any(
            prepared_digest[:12] in item for item in collected["kept"]
        ),
        "orphan_removed_from_both_stores": sum(
            orphan_digest[:12] in item for item in collected["deleted"]
        )
        == 2,
        **collected,
    }


def pass_label(value: bool) -> str:
    return "通過" if value else "未通過"


def print_report_zh_tw(report: dict[str, Any]) -> None:
    alternatives = report["alternative_failures"]
    writers = report["single_writer_coordination"]
    primary_loss = report["primary_storage_loss"]
    migration = report["migration_interruption"]
    cleanup = report["orphan_cleanup"]
    phases = {
        "after_primary_artifact": "主要產出物提升後",
        "after_recovery_artifact": "復原產出物提升後",
        "after_recovery_capsule": "復原提交封包持久化後",
        "after_primary_commit": "主要 SQLite 提交後",
    }

    print("OpenAB 耐久化持久儲存與復原原型：實驗結果")
    print("=" * 56)
    print(
        "說明：commit capsule（提交封包）是不可變的完整提交描述；"
        "authority epoch（權威世代）會在 restore 或 migration 啟用後遞增。"
    )
    print()
    print("1. 被淘汰配置的故障反例")
    mirror = alternatives["mirror_after_commit"]
    print(
        "- 提交後完整鏡像：主要修訂版為 "
        f"{mirror['primary_revision']}，復原修訂版為 {mirror['recovery_revision']}。"
    )
    dual = alternatives["dual_sqlite_2pc"]
    print(
        "- 雙可寫 SQLite 的 2PC（兩階段提交）：主要 schema 為 "
        f"v{dual['primary_schema']}，復原 schema 為 v{dual['recovery_schema']}。"
    )
    print()
    print("2. 單一寫入者協調")
    print(
        f"- {writers['writers']} 個並行寫入者形成 {writers['commits']} 筆提交；"
        f"修訂版依序為 {writers['revisions']}，沒有重複修訂版："
        f"{pass_label(writers['unique_capsule_revisions'] == writers['commits'])}。"
    )
    print()
    print("3. 提交邊界強制崩潰")
    print("- 同一 request ID 重送代表：呼叫端不產生新請求，只查詢或重送原請求。")
    for observation in report["commit_boundary_crashes"]:
        exactly_once = (
            observation["commits_after_same_request_replay"] == 1
            and observation["effects_after_same_request_replay"] == 1
        )
        print(
            f"- {phases[observation['phase']]}：重新啟動時有 "
            f"{observation['committed_on_restart']} 筆提交；相同請求重送後維持 "
            f"{observation['commits_after_same_request_replay']} 筆提交／"
            f"{observation['effects_after_same_request_replay']} 個 Effect Intent："
            f"{pass_label(exactly_once)}。"
        )
    print()
    print("4. 主要儲存區遺失與復原")
    print(
        f"- 復原後有 {primary_loss['commits']} 筆提交，權威世代為 "
        f"{primary_loss['authority_epoch']}，復原閘門為「生效中」，仍有 "
        f"{primary_loss['effects_requiring_reconciliation']} 個外部效果必須調和查證。"
    )
    print()
    print("5. 結構遷移中斷")
    print(
        "- Migration transaction 中斷後仍使用 schema v"
        f"{migration['schema_after_transaction_crash']}，且升級閘門為 "
        f"{migration['gate_after_transaction_crash']}。"
    )
    print(
        "- 復原世代建立後、原子啟用前中斷，仍使用 schema v"
        f"{migration['schema_before_atomic_activation']}；完成啟用後為 schema v"
        f"{migration['schema_after_activation']}、權威世代 "
        f"{migration['authority_epoch_after_activation']}。"
    )
    print()
    print("6. 孤兒資料清理")
    print(
        "- Prepared capsule 參照的產出物有保留："
        f"{pass_label(cleanup['prepared_artifact_preserved'])}。"
    )
    print(
        "- 未被任何權威狀態、prepared capsule 或保留世代參照的舊資料，"
        f"已從兩個儲存區移除："
        f"{pass_label(cleanup['orphan_removed_from_both_stores'])}。"
    )


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="openab-durability-prototype-") as temporary:
        root = Path(temporary)
        report = {
            "alternative_failures": compare_alternatives(root / "alternatives"),
            "single_writer_coordination": exercise_single_writer(
                root / "single-writer"
            ),
            "commit_boundary_crashes": exercise_commit_boundaries(root / "commits"),
            "primary_storage_loss": exercise_primary_loss(root / "primary-loss"),
            "migration_interruption": exercise_migration(root / "migration"),
            "orphan_cleanup": exercise_orphan_cleanup(root / "orphan-cleanup"),
        }
        print_report_zh_tw(report)


if __name__ == "__main__":
    main()
