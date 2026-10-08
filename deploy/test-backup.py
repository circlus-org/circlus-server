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
    print('PASS: backup integrity, path traversal and symlink checks')
