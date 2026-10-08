#!/usr/bin/env python3
"""Backup and restore the standard Circlus Docker Compose installation.

This intentionally refuses alternate Compose projects, mounts and storage paths.
Run from any directory with sudo; see deploy/README.md before clearing data.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from datetime import datetime, timezone


ROOT = Path(__file__).resolve().parent.parent
PROJECT = "circlus-server"
VOLUMES = {"postgres_data": f"{PROJECT}_postgres_data", "server_data": f"{PROJECT}_server_data"}
SETTINGS = (
    "deploy/.env",
    "deploy/ice/turn-clusters.json",
    "deploy/secrets/ice-s2s.secret",
    "deploy/secrets/ice-subject-id.secret",
    "deploy/secrets/turn-local.secret",
    "deploy/secrets/push-config-encryption.secret",
    "deploy/secrets/circle-migration.secret",
)
STORAGE_KEYS = (
    "ATTACHMENTS_STORAGE_DIR",
    "PUBLIC_SITE_STORAGE_DIR",
    "PUBLIC_SITE_ASSETS_DIR",
    "CIRCLE_MIGRATION_EXPORT_DIR",
    "CIRCLE_MIGRATION_IMPORT_DIR",
)
OVERRIDE_KEYS = (
    "CIRCLUS_ENV_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_FILE", "COMPOSE_PROFILES",
    "DOCKER_HOST", "DOCKER_CONTEXT", "CIRCLUS_IMAGE_TAG",
    "ICE_CONFIG_FILE", "ICE_SECRETS_DIR", "ICE_S2S_SECRET_FILE",
    "ICE_SUBJECT_ID_SECRET_FILE", "TURN_LOCAL_SECRET_FILE",
    "PUSH_CONFIG_ENCRYPTION_SECRET_FILE", "CIRCLE_MIGRATION_SECRET_FILE",
)


class BackupError(Exception):
    pass


def require(condition, message):
    if not condition:
        raise BackupError(message)


def run(argv, *, stdin=None, stdout=None, env=None, check=True):
    result = subprocess.run(argv, cwd=ROOT, stdin=stdin, stdout=stdout or subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env, check=False)
    if check and result.returncode:
        error = result.stderr.decode(errors="replace").strip()
        raise BackupError(f"Command failed: {' '.join(map(str, argv))}\n{error}")
    return result


def require_regular(path):
    require(path.is_file() and not path.is_symlink(), f"Expected a regular file: {path}")


def require_safe_host_paths():
    for key in OVERRIDE_KEYS:
        require(not os.environ.get(key), f"Unsupported environment override: {key}")
    require(run(["docker", "context", "show"]).stdout.decode().strip() == "default",
            "Only the local default Docker context is supported")
    endpoint = run(["docker", "context", "inspect", "default", "--format",
                    "{{json .Endpoints.docker.Host}}"] ).stdout.decode().strip()
    require(json.loads(endpoint).startswith("unix://"),
            "Only a local Unix Docker socket is supported")
    containers = run(["docker", "ps", "-a", "--filter",
                      "label=com.docker.compose.project.working_dir",
                      "--format", "{{.ID}}"]).stdout.decode().splitlines()
    for container_id in containers:
        info = json.loads(run(["docker", "inspect", container_id]).stdout)[0]
        labels = info["Config"].get("Labels") or {}
        if labels.get("com.docker.compose.project.working_dir") == str(ROOT):
            require(labels.get("com.docker.compose.project") == PROJECT,
                    "This checkout has containers from a different Compose project")
    for relative in ("compose.yaml", "compose.prebuilt.yaml"):
        require_regular(ROOT / relative)
    for directory in (ROOT / "deploy", ROOT / "deploy/ice", ROOT / "deploy/secrets"):
        require(directory.is_dir() and not directory.is_symlink(),
                f"Expected a local directory, not a symlink: {directory}")


def image_tag(env_file):
    tag = ""
    for line in env_file.read_text().splitlines():
        entry = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$", line)
        if not entry:
            continue
        key, value = entry.groups()
        if key == "CIRCLUS_IMAGE_TAG":
            tag = value.strip().strip("\"'")
        if key == "CIRCLUS_ENV_FILE" and value.strip().strip("\"'"):
            raise BackupError("CIRCLUS_ENV_FILE in deploy/.env is unsupported")
    require(not tag or re.fullmatch(r"[A-Za-z0-9_.-]+", tag),
            "Unsupported CIRCLUS_IMAGE_TAG format")
    return tag


def compose_args(env_file):
    args = ["docker", "compose", "--env-file", str(env_file), "-f", "compose.yaml"]
    if image_tag(env_file):
        args += ["-f", "compose.prebuilt.yaml"]
    return args + ["--profile", "local-turn"]


def compose_env(env_file):
    env = os.environ.copy()
    env["CIRCLUS_ENV_FILE"] = str(env_file)
    return env


def compose(env_file, *args, stdin=None, stdout=None):
    return run(compose_args(env_file) + list(args), stdin=stdin, stdout=stdout,
               env=compose_env(env_file))


def expected_mounts(service):
    mounts = {
        "postgres": [
            ("volume", "postgres_data", "/var/lib/postgresql/data"),
            ("bind", str(ROOT / "server/config/postgresql-small-server.conf"),
             "/etc/postgresql/postgresql.conf"),
        ],
        "server": [("volume", "server_data", "/app/server/server-data")],
        "ice-config-service": [
            ("bind", str(ROOT / "deploy/ice/turn-clusters.json"),
             "/app/config/turn-clusters.json"),
            ("bind", str(ROOT / "deploy/secrets"), "/run/circlus-secrets"),
        ],
        "coturn": [
            ("bind", str(ROOT / "deploy/coturn/turnserver.conf.template"),
             "/opt/circlus/turnserver.conf.template"),
            ("bind", str(ROOT / "deploy/coturn/start-coturn.sh"),
             "/opt/circlus/start-coturn.sh"),
        ],
        "migrate": [],
    }
    return mounts[service]


def check_config(env_file):
    require_regular(env_file)
    config = json.loads(compose(env_file, "config", "--format", "json").stdout)
    raw_config = json.loads(compose(env_file, "config", "--no-env-resolution",
                                    "--format", "json").stdout)
    env_files = raw_config.get("services", {}).get("server", {}).get("env_file", [])
    require(len(env_files) == 1 and isinstance(env_files[0], dict) and
            env_files[0].get("path") == str(env_file),
            "Unsupported server env_file path")
    require(config.get("name") == PROJECT, "Unsupported Compose project name")
    require(set(config.get("services", {})) == set(
        ("postgres", "server", "migrate", "ice-config-service", "coturn")),
        "Unsupported Compose services")
    for service in config["services"]:
        actual = [(m.get("type"), m.get("source"), m.get("target"))
                  for m in config["services"][service].get("volumes", [])]
        require(sorted(actual) == sorted(expected_mounts(service)),
                f"Unsupported volume or bind path in {service}: {actual}")
    for key, name in VOLUMES.items():
        volume_spec = config.get("volumes", {}).get(key, {})
        require(volume_spec.get("name") == name and not volume_spec.get("external"),
                f"Unsupported Docker volume: {key}")
    require(set(config.get("volumes", {})) == set(VOLUMES),
            "Unexpected Docker volumes in Compose")
    secrets = {
        "ice_s2s": "ice-s2s.secret",
        "ice_subject_id": "ice-subject-id.secret",
        "turn_local": "turn-local.secret",
        "push_config_encryption": "push-config-encryption.secret",
        "circle_migration": "circle-migration.secret",
    }
    require(set(config.get("secrets", {})) == set(secrets), "Unsupported Compose secrets")
    for key, filename in secrets.items():
        require(config["secrets"][key].get("file") == str(ROOT / "deploy/secrets" / filename),
                f"Unsupported secret path: {key}")
    for service, expected in {
        "server": {"ice_s2s", "ice_subject_id", "push_config_encryption", "circle_migration"},
        "coturn": {"turn_local"},
    }.items():
        mounted = config["services"][service].get("secrets", [])
        require({(item.get("source"), item.get("target")) for item in mounted} ==
                {(key, f"/run/secrets/{key}") for key in expected},
                f"Unsupported mounted secrets in {service}")
        groups = config["services"][service].get("group_add", [])
        require(len(groups) == 1 and str(groups[0]).isdigit(),
                f"Unsupported secret group in {service}")
    postgres = config["services"]["postgres"]
    require(postgres.get("image") == "postgres:16-alpine", "Unsupported PostgreSQL image")
    pg_env = postgres.get("environment", {})
    require(pg_env.get("POSTGRES_DB") == "family_messenger" and
            pg_env.get("POSTGRES_USER") == "fm_user" and pg_env.get("POSTGRES_PASSWORD"),
            "Unsupported or incomplete PostgreSQL settings")
    server_env = config["services"]["server"].get("environment", {})
    for key in STORAGE_KEYS:
        require(not server_env.get(key), f"Custom {key} is outside server_data")
    for key, secret in {
        "ICE_CONFIG_SHARED_SECRET_FILE": "ice_s2s",
        "ICE_SUBJECT_ID_SECRET_FILE": "ice_subject_id",
        "MANAGED_PUSH_CONFIG_ENCRYPTION_KEY_FILE": "push_config_encryption",
        "CIRCLE_MIGRATION_SECRET_KEY_BASE64_FILE": "circle_migration",
    }.items():
        require(server_env.get(key) == f"/run/secrets/{secret}",
                f"Unsupported server secret setting: {key}")
    require(server_env.get("VPS_ID") and
            server_env.get("DATABASE_URL", "").endswith("@postgres:5432/family_messenger"),
            "Unsupported or incomplete server database settings")
    for relative in SETTINGS[1:]:
        # During restore these files may not exist yet, but their parent paths
        # must remain the standard local directories.
        path = ROOT / relative
        require(not path.is_symlink(), f"Unsupported symlink: {path}")
    return config


def current_commit():
    return run(["git", "-c", f"safe.directory={ROOT}", "rev-parse", "HEAD"]).stdout.decode().strip()


def check_volume_owner(volume_key):
    volume = json.loads(run(["docker", "volume", "inspect", VOLUMES[volume_key]]).stdout)[0]
    labels = volume.get("Labels") or {}
    require(labels.get("com.docker.compose.project") == PROJECT and
            labels.get("com.docker.compose.volume") == volume_key,
            f"Unexpected Docker volume owner: {VOLUMES[volume_key]}")


def check_service_mount(env_file, service, volume_key, destination, *, must_run=True):
    result = compose(env_file, "ps", "-q", "--all", service).stdout.decode().strip().splitlines()
    require(len(result) == 1 and result[0], f"{service} container is missing")
    info = json.loads(run(["docker", "inspect", result[0]]).stdout)[0]
    labels = info["Config"].get("Labels") or {}
    require((not must_run or info["State"]["Running"]) and
            labels.get("com.docker.compose.project") == PROJECT and
            labels.get("com.docker.compose.service") == service and
            labels.get("com.docker.compose.project.working_dir") == str(ROOT),
            f"Unexpected {service} container")
    mounts = [m for m in info["Mounts"] if m["Destination"] == destination]
    require(len(mounts) == 1 and mounts[0]["Type"] == "volume" and
            mounts[0]["Name"] == VOLUMES[volume_key],
            f"Unexpected {service} data mount")
    check_volume_owner(volume_key)
    return bool(info["State"]["Running"])


def check_existing_volumes():
    for key, name in VOLUMES.items():
        check_volume_owner(key)
        attached = run(["docker", "ps", "-a", "--filter", f"volume={name}",
                        "--format", "{{.ID}}"]).stdout.decode().splitlines()
        for container_id in attached:
            info = json.loads(run(["docker", "inspect", container_id]).stdout)[0]
            labels = info["Config"].get("Labels") or {}
            service = "postgres" if key == "postgres_data" else "server"
            destination = ("/var/lib/postgresql/data" if key == "postgres_data"
                           else "/app/server/server-data")
            require(labels.get("com.docker.compose.project") == PROJECT and
                    labels.get("com.docker.compose.service") == service and
                    labels.get("com.docker.compose.project.working_dir") == str(ROOT) and
                    any(m.get("Type") == "volume" and m.get("Name") == name and
                        m.get("Destination") == destination for m in info["Mounts"]),
                    f"Unexpected container uses {name}: {container_id}")


def check_runtime_compose_files(env_file):
    config = check_config(env_file)
    expected_files = [str(ROOT / "compose.yaml")]
    if image_tag(env_file):
        expected_files.append(str(ROOT / "compose.prebuilt.yaml"))
    ids = run(["docker", "ps", "-a", "--filter", f"label=com.docker.compose.project={PROJECT}",
               "--format", "{{.ID}}"]).stdout.decode().splitlines()
    require(ids, "No existing Compose containers to verify")
    for container_id in ids:
        info = json.loads(run(["docker", "inspect", container_id]).stdout)[0]
        labels = info["Config"].get("Labels") or {}
        service = labels.get("com.docker.compose.service")
        require(labels.get("com.docker.compose.project.working_dir") == str(ROOT) and
                labels.get("com.docker.compose.project.config_files", "").split(",") == expected_files and
                service in config["services"],
                f"Container {container_id} used another Compose checkout or override")
        actual_mounts = {(m["Destination"], m["Type"],
                          m["Name"] if m["Type"] == "volume" else m["Source"])
                         for m in info["Mounts"]}
        expected_mounts = set()
        for mount in config["services"][service].get("volumes", []):
            source = (VOLUMES[mount["source"]] if mount["type"] == "volume"
                      else mount["source"])
            expected_mounts.add((mount["target"], mount["type"], source))
        for secret in config["services"][service].get("secrets", []):
            source = config["secrets"][secret["source"]]["file"]
            expected_mounts.add((secret["target"], "bind", source))
        require(actual_mounts == expected_mounts,
                f"Runtime mounts differ from the standard layout in {service}")
        if service != "migrate":
            actual_env = dict(entry.split("=", 1) for entry in info["Config"].get("Env", [])
                              if "=" in entry)
            for key, value in config["services"][service].get("environment", {}).items():
                require(actual_env.get(key) == str(value),
                        f"Runtime setting differs from deploy/.env: {service}.{key}")


def check_existing_install(env_file, *, postgres_running):
    check_runtime_compose_files(env_file)
    check_service_mount(env_file, "postgres", "postgres_data", "/var/lib/postgresql/data",
                        must_run=postgres_running)
    server_running = check_service_mount(env_file, "server", "server_data",
                                         "/app/server/server-data", must_run=False)
    check_existing_volumes()
    return server_running


def check_running_install(env_file):
    server_running = check_existing_install(env_file, postgres_running=True)
    require(not compose(env_file, "ps", "-q", "migrate").stdout.strip(),
            "Migration is running; wait before creating a backup")
    return server_running


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def backup_files(directory):
    return ["database.dump", "server-data.tar"] + [f"settings/{name}" for name in SETTINGS]


def check_server_tar(path):
    seen = set()
    with tarfile.open(path, "r:") as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            require(not name.is_absolute() and ".." not in name.parts and
                    (member.isfile() or member.isdir()),
                    f"Unsafe or unsupported server_data entry: {member.name}")
            require(str(name) not in seen, f"Duplicate server_data entry: {member.name}")
            seen.add(str(name))


def verify_backup(directory):
    require(directory.is_dir() and not directory.is_symlink(),
            f"Backup directory not found or is a symlink: {directory}")
    manifest_path = directory / "manifest.json"
    require_regular(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    require(manifest.get("format") == 1 and manifest.get("project") == PROJECT,
            "Unsupported backup format or project")
    files = backup_files(directory)
    require(set(manifest.get("sha256", {})) == set(files), "Incomplete backup manifest")
    entries = list(directory.rglob("*"))
    require(all(not path.is_symlink() for path in entries),
            "Backup contains a symlink")
    require(set(str(p.relative_to(directory)) for p in entries if p.is_file()) ==
            set(files + ["manifest.json"]), "Unexpected or missing backup files")
    for relative in files:
        path = directory / relative
        require_regular(path)
        require(sha256(path) == manifest["sha256"][relative],
                f"Backup checksum mismatch: {relative}")
    check_server_tar(directory / "server-data.tar")
    require(manifest.get("commit") and manifest.get("vps_id"), "Incomplete backup identity")
    return manifest


def require_image(image):
    require(run(["docker", "image", "inspect", image], check=False).returncode == 0,
            f"Required local image is missing: {image}. Pull it before retrying.")


def copy_server_data(volume, image, archive_path, *, restore=False):
    mount = f"type=volume,source={volume},target=/data"
    if not restore:
        mount += ",readonly"
    args = ["docker", "run", "--rm", "-i", "--network", "none", "--pull", "never",
            "--mount", mount, "--entrypoint", "tar", image, "-C", "/data"]
    if restore:
        with archive_path.open("rb") as source:
            run(args + ["-xf", "-"], stdin=source)
    else:
        with archive_path.open("wb") as output:
            run(args + ["-cf", "-", "."], stdout=output)


def create_backup(*, leave_stopped=False):
    require_safe_host_paths()
    env_file = ROOT / "deploy/.env"
    config = check_config(env_file)
    for relative in SETTINGS:
        require_regular(ROOT / relative)
    server_was_running = check_running_install(env_file)
    image = config["services"]["postgres"]["image"]
    require_image(image)
    commit = current_commit()
    tracked_changes = run(["git", "-c", f"safe.directory={ROOT}", "status",
                           "--porcelain", "--untracked-files=no"]).stdout.strip()
    require(not tracked_changes, "Tracked checkout files have local changes; commit or revert them first")
    backup_root = ROOT / "backups"
    require(not backup_root.is_symlink(), "backups/ must not be a symlink")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    destination = backup_root / f"circlus-{stamp}"
    require(not destination.exists(), f"Backup already exists: {destination}")
    backup_root.mkdir(mode=0o700, exist_ok=True)
    os.chmod(backup_root, 0o700)
    staging = Path(tempfile.mkdtemp(prefix=".incomplete-", dir=backup_root))
    os.chmod(staging, 0o700)
    stopped = False
    finished = False
    try:
        if server_was_running:
            print("Stopping the API for a consistent backup...", flush=True)
            stopped = True
            compose(env_file, "stop", "--timeout", "60", "server")
        print("Saving PostgreSQL...", flush=True)
        with (staging / "database.dump").open("wb") as output:
            compose(env_file, "exec", "-T", "postgres", "pg_dump", "-U", "fm_user",
                    "-d", "family_messenger", "-Fc", stdout=output)
        with (staging / "database.dump").open("rb") as source:
            compose(env_file, "exec", "-T", "postgres", "pg_restore", "--list", stdin=source)
        print("Saving server_data and settings...", flush=True)
        copy_server_data(VOLUMES["server_data"], image, staging / "server-data.tar")
        for relative in SETTINGS:
            target = staging / "settings" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ROOT / relative, target)
        files = backup_files(staging)
        manifest = {
            "format": 1,
            "project": PROJECT,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "commit": commit,
            "image_tag": image_tag(env_file),
            "vps_id": config["services"]["server"]["environment"]["VPS_ID"],
            "sha256": {name: sha256(staging / name) for name in files},
        }
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        verify_backup(staging)
        if stopped and not leave_stopped:
            print("Starting the API...", flush=True)
            compose(env_file, "start", "server")
            stopped = False
        staging.rename(destination)
        finished = True
        if leave_stopped:
            stopped = False  # Intentional downtime for the replace-data workflow.
    finally:
        try:
            if not finished:
                shutil.rmtree(staging)
        finally:
            if stopped:
                try:
                    compose(env_file, "start", "server")
                except BackupError as exc:
                    print(f"WARNING: server could not be restarted: {exc}", file=sys.stderr)
    print(f"Backup ready: {destination}")
    print("Copy this directory off the VPS. Test restoration on a separate installation.")
    if leave_stopped:
        print("The API remains stopped. Restart it if you do not continue with restore.")


def check_backup_for_this_install(directory):
    require_safe_host_paths()
    manifest = verify_backup(directory)
    require(current_commit() == manifest["commit"],
            "Checkout differs from backup. Switch to the backed-up commit/tag first.")
    archived_env = directory / "settings/deploy/.env"
    config = check_config(archived_env)
    require(image_tag(archived_env) == manifest["image_tag"] and
            config["services"]["server"]["environment"]["VPS_ID"] == manifest["vps_id"],
            "Backup settings do not match its manifest")
    current_env = ROOT / "deploy/.env"
    if current_env.exists():
        check_config(current_env)
    for relative in SETTINGS:
        target = ROOT / relative
        require(not target.is_symlink() and (not target.exists() or target.is_file()),
                f"Unsupported settings path: {target}")
    return manifest, archived_env, config


def clear_install(source, rescue):
    require(source.resolve() != rescue.resolve(), "Source and rescue backups must differ")
    source_manifest, _, _ = check_backup_for_this_install(source)
    rescue_manifest = verify_backup(rescue)
    rescue_env = rescue / "settings/deploy/.env"
    rescue_config = check_config(rescue_env)
    require(image_tag(rescue_env) == rescue_manifest["image_tag"] and
            rescue_config["services"]["server"]["environment"]["VPS_ID"] == rescue_manifest["vps_id"],
            "Rescue settings do not match its manifest")
    env_file = ROOT / "deploy/.env"
    require_regular(env_file)
    config = check_config(env_file)
    check_existing_install(env_file, postgres_running=False)
    current_vps = config["services"]["server"]["environment"]["VPS_ID"]
    require(source_manifest["vps_id"] == current_vps and
            rescue_manifest["vps_id"] == current_vps,
            "Both backups must belong to this VPS_ID")
    print(f"Restore source: {source}")
    print(f"Rescue copy of current state: {rescue}")
    print("This removes the current PostgreSQL and server_data Docker volumes.")
    answer = input(f"Type DELETE {PROJECT} to continue: ")
    require(answer == f"DELETE {PROJECT}", "Cancelled; no data was removed")
    # Recheck immediately before the destructive Compose command.
    check_existing_install(env_file, postgres_running=False)
    compose(env_file, "down", "-v")
    print("Current Compose data removed. Restore the selected source next:")
    print(f"  sudo python3 deploy/backup.py restore {source}")


def restore_backup(directory):
    manifest, archived_env, config = check_backup_for_this_install(directory)
    for volume in VOLUMES.values():
        require(run(["docker", "volume", "inspect", volume], check=False).returncode != 0,
                f"Target volume already exists: {volume}. Nothing was changed.")
    require(not compose(archived_env, "ps", "-q", "--all").stdout.strip(),
            "Compose containers still exist. Nothing was changed.")
    image = config["services"]["postgres"]["image"]
    if run(["docker", "image", "inspect", image], check=False).returncode != 0:
        # Pull only after all path and data checks pass. No settings or volumes
        # have been changed yet.
        run(["docker", "pull", image])
    print(f"Restoring {directory} for VPS_ID {manifest['vps_id']}.")
    created = []
    try:
        for relative in SETTINGS:
            target = ROOT / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(directory / "settings" / relative, target)
        os.chmod(ROOT / "deploy/.env", 0o600)
        server_gid = int(config["services"]["server"]["group_add"][0])
        turn_gid = int(config["services"]["coturn"]["group_add"][0])
        for relative in SETTINGS[2:]:
            secret = ROOT / relative
            os.chown(secret, 0, turn_gid if secret.name == "turn-local.secret" else server_gid)
            os.chmod(secret, 0o640)
        for key, volume in VOLUMES.items():
            run(["docker", "volume", "create", "--label", f"com.docker.compose.project={PROJECT}",
                 "--label", f"com.docker.compose.volume={key}", volume])
            created.append(volume)
        copy_server_data(VOLUMES["server_data"], config["services"]["postgres"]["image"],
                         directory / "server-data.tar", restore=True)
        compose(ROOT / "deploy/.env", "up", "-d", "postgres")
        for _ in range(60):
            result = compose(ROOT / "deploy/.env", "ps", "-q", "postgres").stdout.decode().strip()
            if result:
                state = json.loads(run(["docker", "inspect", result]).stdout)[0]["State"]
                if state.get("Health", {}).get("Status") == "healthy":
                    break
            time.sleep(2)
        else:
            raise BackupError("PostgreSQL did not become healthy")
        with (directory / "database.dump").open("rb") as source:
            compose(ROOT / "deploy/.env", "exec", "-T", "postgres", "pg_restore",
                    "-U", "fm_user", "-d", "family_messenger", "--single-transaction",
                    "--exit-on-error", stdin=source)
    except BaseException:
        # These volumes were absent before this invocation. Keep the selected
        # backup untouched and remove only the partial target created here.
        if created:
            try:
                compose(ROOT / "deploy/.env", "down")
                for volume in reversed(created):
                    run(["docker", "volume", "rm", volume])
                print("Partial target removed; the selected backup is unchanged.", file=sys.stderr)
            except Exception as cleanup_error:
                print(f"Partial target could not be removed: {cleanup_error}", file=sys.stderr)
                print("Do not start the server; inspect the volumes before retrying.", file=sys.stderr)
        raise
    print("Data restored. Start services only after checking the output:")
    print("  sudo ./deploy/compose.sh up -d")


def interrupted(_signum, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create", help="back up a standard installation")
    create.add_argument("--leave-stopped", action="store_true",
                        help="keep the API stopped for a planned replacement")
    for name in ("verify", "restore"):
        sub = commands.add_parser(name)
        sub.add_argument("backup", type=Path)
    clear = commands.add_parser("clear", help="remove current data after verifying two backups")
    clear.add_argument("source", type=Path, help="the backup to restore")
    clear.add_argument("rescue", type=Path, help="a separate copy of current data")
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGHUP, interrupted)
    try:
        os.umask(0o077)
        if args.command != "verify":
            require(os.geteuid() == 0, "Run with sudo so Docker and secrets are accessible")
        if args.command == "create":
            create_backup(leave_stopped=args.leave_stopped)
        elif args.command == "verify":
            manifest = verify_backup(args.backup.absolute())
            print(f"Backup verified: {args.backup.absolute()}")
            print(f"Created: {manifest['created_at']}; image tag: {manifest['image_tag'] or 'source build'}")
            print(f"Code commit: {manifest['commit']}; VPS_ID: {manifest['vps_id']}")
        elif args.command == "clear":
            clear_install(args.source.absolute(), args.rescue.absolute())
        else:
            restore_backup(args.backup.absolute())
    except KeyboardInterrupt:
        print("Backup operation interrupted; check the service status before retrying.",
              file=sys.stderr)
        return 130
    except (BackupError, OSError, ValueError, EOFError, TypeError, AttributeError, tarfile.TarError) as exc:
        print(f"Backup operation stopped: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
