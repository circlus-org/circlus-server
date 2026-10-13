#!/usr/bin/env python3
"""Check that damaged or unsafe backups are rejected before restore uses them."""

import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile

sys.dont_write_bytecode = True
script = Path(__file__).with_name('backup.py')
spec = importlib.util.spec_from_file_location('circlus_backup', script)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


def make_tar(path, name='.'):
    with tarfile.open(path, 'w') as archive:
        if name == '.':
            entry = tarfile.TarInfo(name)
            entry.type = tarfile.DIRTYPE
            archive.addfile(entry)
        else:
            data = b'bad path'
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            from io import BytesIO
            archive.addfile(entry, BytesIO(data))


def write_manifest(folder):
    files = backup.backup_files(folder)
    manifest = {
        'format': 1,
        'project': backup.PROJECT,
        'commit': 'a' * 40,
        'vps_id': 'test-vps',
        'image_tag': 'v1.0.0',
        'created_at': 'test',
        'sha256': {
            name: hashlib.sha256((folder / name).read_bytes()).hexdigest()
            for name in files
        },
    }
    (folder / 'manifest.json').write_text(json.dumps(manifest))


def rejected(folder):
    try:
        backup.verify_backup(folder)
    except backup.BackupError:
        return
    raise AssertionError('unsafe backup accepted')


with tempfile.TemporaryDirectory() as temp:
    folder = Path(temp) / 'selected'
    folder.mkdir()
    for name in backup.backup_files(folder):
        path = folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if name == 'server-data.tar':
            make_tar(path)
        else:
            path.write_text('test')
    write_manifest(folder)
    backup.verify_backup(folder)

    secret = folder / 'settings/deploy/secrets/ice-s2s.secret'
    secret.write_text('tampered')
    rejected(folder)
    secret.write_text('test')

    make_tar(folder / 'server-data.tar', '../outside')
    write_manifest(folder)
    rejected(folder)
    make_tar(folder / 'server-data.tar')
    write_manifest(folder)

    (folder / 'extra').symlink_to('/etc/passwd')
    rejected(folder)
    # Compose versions render env_file as either a path string or a path object.
    expected = backup.ROOT / 'deploy/.env'

    def config(entry):
        return {'services': {'server': {'env_file': [entry]}}}

    for entry in (str(expected), './deploy/.env', {'path': str(expected)},
                  {'path': str(expected), 'required': True}):
        backup.check_server_env_file(config(entry), expected)
    alias = Path(temp) / 'env-alias'
    alias.symlink_to(expected)
    for entry in ('/tmp/another.env', {'path': str(expected), 'required': False},
                  {'path': str(expected), 'format': 'raw'}, str(alias)):
        try:
            backup.check_server_env_file(config(entry), expected)
        except backup.BackupError:
            pass
        else:
            raise AssertionError(f'unsafe server env_file accepted: {entry!r}')
    compose_source = (backup.ROOT / 'compose.yaml').read_text()
    prebuilt_source = (backup.ROOT / 'compose.prebuilt.yaml').read_text()
    backup.check_server_env_file({'services': {'server': {}}}, expected)
    backup.check_server_env_file_sources(compose_source, prebuilt_source)
    for source, override in (
        (compose_source.replace('${CIRCLUS_ENV_FILE:-./deploy/.env}',
                                './deploy/other.env'), prebuilt_source),
        (compose_source.replace('    env_file:\n',
                                '    env_file: ./deploy/other.env\n    env_file:\n'),
         prebuilt_source),
        (compose_source, prebuilt_source + '\nservices:\n  server:\n'
         '    env_file:\n      - ./deploy/other.env\n'),
    ):
        try:
            backup.check_server_env_file_sources(source, override)
        except backup.BackupError:
            pass
        else:
            raise AssertionError('unsafe Compose env_file source accepted')
    base_files = [str(backup.ROOT / 'compose.yaml')]
    release_files = base_files + [str(backup.ROOT / 'compose.prebuilt.yaml')]
    for service in ('postgres', 'coturn'):
        assert backup.runtime_compose_files_match(service, base_files, release_files,
                                                 prebuilt_source)
    for service in ('server', 'migrate', 'ice-config-service'):
        assert not backup.runtime_compose_files_match(service, base_files, release_files,
                                                     prebuilt_source)
    assert backup.runtime_compose_files_match('coturn', release_files, release_files,
                                             prebuilt_source)
    assert not backup.runtime_compose_files_match(
        'coturn', base_files, release_files, prebuilt_source + '\n  coturn:\n')
    required_mounts = {
        ('/opt/circlus/start-coturn.sh', 'bind', '/checkout/deploy/coturn/start-coturn.sh'),
        ('/run/secrets/turn_local', 'bind', '/checkout/deploy/secrets/turn-local.secret'),
    }
    image_mount = ('/var/lib/coturn', 'volume', 'anonymous-volume-id')
    assert backup.runtime_mounts_match('coturn', required_mounts | {image_mount},
                                       required_mounts, {'/var/lib/coturn'})
    assert not backup.runtime_mounts_match('coturn', required_mounts | {image_mount},
                                           required_mounts, set())
    assert not backup.runtime_mounts_match('server', required_mounts | {image_mount},
                                           required_mounts, {'/var/lib/coturn'})
    assert not backup.runtime_mounts_match('coturn', {image_mount}, required_mounts,
                                           {'/var/lib/coturn'})
    assert not backup.runtime_mounts_match('coturn', required_mounts | {image_mount,
                                                ('/other', 'volume', 'other-volume')},
                                           required_mounts, {'/var/lib/coturn'})
    print('PASS: backup integrity, path traversal, symlink and Compose compatibility checks')
