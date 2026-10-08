#!/usr/bin/env python3
"""Checks deploy/compose.sh argument selection and release tag guard without Docker."""
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd, env=None, ok=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True)
    if ok and result.returncode != 0:
        raise AssertionError(f'{args} failed:\n{result.stdout}\n{result.stderr}')
    return result


with tempfile.TemporaryDirectory() as tmp:
    base = Path(tmp)
    install = base / 'circlus-server'
    (install / 'deploy').mkdir(parents=True)
    shutil.copy2(ROOT / 'deploy/compose.sh', install / 'deploy/compose.sh')
    settings = install / 'deploy/.env'

    # A stub docker records its arguments, one per line.
    stub = base / 'bin'
    stub.mkdir()
    record = base / 'docker-args'
    (stub / 'docker').write_text(f'#!/bin/sh\nprintf "%s\\n" "$@" > "{record}"\n')
    (stub / 'docker').chmod(0o755)
    env = {k: v for k, v in os.environ.items() if k not in ('CIRCLUS_IMAGE_TAG', 'CIRCLUS_ENV_FILE')}
    env['PATH'] = f'{stub}:{env["PATH"]}'

    def compose(*args, ok=True, cwd=base, **extra):
        record.unlink(missing_ok=True)
        result = run([str(install / 'deploy/compose.sh'), *args], cwd=cwd, env={**env, **extra}, ok=ok)
        recorded = record.read_text().splitlines() if record.exists() else None
        return result, recorded

    result, recorded = compose('ps', ok=False)
    assert result.returncode != 0 and recorded is None and 'deploy/.env.example' in result.stderr

    settings.write_text('# CIRCLUS_IMAGE_TAG=v9.9.9\nTURN_PUBLIC_HOST=circle.example.com\n')
    result, recorded = compose('ps', '-a')
    assert recorded == ['compose', '--env-file', 'deploy/.env', '-f', 'compose.yaml',
                        '--profile', 'local-turn', 'ps', '-a'], recorded
    assert 'built from source' in result.stderr and '+ docker compose' in result.stderr
    print('PASS: empty tag uses source build files from any working directory', flush=True)

    # Without a Git checkout (for example an unpacked archive) the tag is not checked.
    settings.write_text('CIRCLUS_IMAGE_TAG="v1.2.3"\r\n')
    _, recorded = compose('up', '-d')
    assert recorded == ['compose', '--env-file', 'deploy/.env', '-f', 'compose.yaml',
                        '-f', 'compose.prebuilt.yaml', '--profile', 'local-turn', 'up', '-d'], recorded

    git = ['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid']
    run(['git', 'init', '-q'], cwd=install)
    run([*git, 'commit', '-q', '--allow-empty', '-m', 'release'], cwd=install)
    run(['git', 'tag', 'v1.2.3'], cwd=install)
    _, recorded = compose('pull')
    assert recorded[-1] == 'pull' and 'compose.prebuilt.yaml' in recorded

    run([*git, 'commit', '-q', '--allow-empty', '-m', 'next'], cwd=install)
    for command in ('up', 'pull', 'create', 'run'):
        result, recorded = compose(command, ok=False)
        assert result.returncode != 0 and recorded is None, command
        assert 'git switch --detach v1.2.3' in result.stderr, result.stderr
    _, recorded = compose('logs', 'server')
    assert recorded[-2:] == ['logs', 'server']
    print('PASS: published images require the matching checked-out release for up/pull/create/run', flush=True)

    # Environment values take precedence over the file, as in Compose.
    _, recorded = compose('ps', CIRCLUS_IMAGE_TAG='')
    assert 'compose.prebuilt.yaml' not in recorded
    alternate = install / 'alternate.env'
    alternate.write_text('TURN_PUBLIC_HOST=circle.example.com\n')
    _, recorded = compose('ps', CIRCLUS_ENV_FILE='alternate.env')
    assert recorded[:3] == ['compose', '--env-file', 'alternate.env'] and 'compose.prebuilt.yaml' not in recorded
    print('PASS: environment overrides select the env file and image tag', flush=True)
