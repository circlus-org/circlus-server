#!/usr/bin/env python3
"""Docker regression tests for a fresh local TURN deployment; no production files."""
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[1]
IMAGE = 'coturn/coturn:4.15.0-r0'


def run(args, *, cwd=None, ok=True, timeout=120, env=None):
    result = subprocess.run(args, cwd=cwd, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    if ok and result.returncode:
        raise AssertionError(f'Command failed: {args[0]}\n{result.stdout}')
    return result


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def prepare(path):
    path.mkdir()
    path.chmod(0o755)
    shutil.copytree(ROOT / 'deploy', path / 'deploy', ignore=shutil.ignore_patterns(
        '.env', 'secrets', 'turn-clusters.json', '__pycache__'))
    shutil.copy(path / 'deploy/.env.example', path / 'deploy/.env')
    env = path / 'deploy/.env'
    env.write_text(env.read_text().replace('TURN_PUBLIC_HOST=', 'TURN_PUBLIC_HOST=turn.test.example'))


def main():
    with tempfile.TemporaryDirectory(prefix='circlus-turn-test-') as directory:
        base = Path(directory)
        base.chmod(0o755)
        stack = base / 'stack'
        prepare(stack)
        first = run(['sh', 'deploy/init-local-turn.sh'], cwd=stack)
        secret = stack / 'deploy/secrets/turn-local.secret'
        original = secret.read_bytes()
        env_before = (stack / 'deploy/.env').read_bytes()
        assert any(line.startswith(b'MOBILE_CALL_ACTION_SECRET=') and len(line.split(b'=', 1)[1]) >= 32
                   for line in env_before.splitlines())
        config_before = (stack / 'deploy/ice/turn-clusters.json').read_bytes()
        assert secret.stat().st_mode & 0o777 == 0o640
        secret.chmod(0o600)
        run(['sh', 'deploy/init-local-turn.sh'], cwd=stack)
        assert secret.read_bytes() == original
        assert secret.stat().st_mode & 0o777 == 0o640
        assert (stack / 'deploy/.env').read_bytes() == env_before
        assert (stack / 'deploy/ice/turn-clusters.json').read_bytes() == config_before
        assert 'sudo ufw allow 3478/tcp' in first.stdout
        # The firewall advice follows the configured ports; it never runs UFW.
        settings = stack / 'deploy/.env'
        settings.write_text(settings.read_text().replace('TURN_LISTEN_PORT=3478', 'TURN_LISTEN_PORT=13478')
                            .replace('TURN_RELAY_MIN_PORT=49160', 'TURN_RELAY_MIN_PORT=55000')
                            .replace('TURN_RELAY_MAX_PORT=49200', 'TURN_RELAY_MAX_PORT=55020'))
        advice = run(['sh', 'deploy/init-local-turn.sh'], cwd=stack).stdout
        assert 'sudo ufw allow 13478/tcp' in advice and 'sudo ufw allow 55000:55020/udp' in advice
        assert (stack / 'deploy/ice/turn-clusters.json').read_bytes() == config_before
        settings.write_bytes(env_before)
        # A file override must get the same permissions and Compose group.
        alternate = stack / 'alternate-turn.secret'
        alternate.write_bytes(original)
        alternate.chmod(0o600)
        settings.write_text(settings.read_text() + '\nTURN_LOCAL_SECRET_FILE=alternate-turn.secret\n')
        run(['sh', 'deploy/init-local-turn.sh'], cwd=stack)
        assert alternate.stat().st_mode & 0o777 == 0o640 and alternate.read_bytes() == original
        settings.write_bytes(env_before)
        print('PASS: initialization repairs permissions, preserves credentials/configuration and prints configured ports', flush=True)

        def probe(secret_path, group=None, tr_failure=False):
            stub = base / 'bin'
            stub.mkdir(exist_ok=True)
            executable = stub / 'turnserver'
            executable.write_text('#!/bin/sh\nset -eu\ntest "$(id -u)" != 0\n'
                                  'test "$(stat -c %a /tmp/turnserver.conf)" = 600\n'
                                  'grep -q "^static-auth-secret=." /tmp/turnserver.conf\necho STARTED\n')
            executable.chmod(0o755)
            tr = stub / 'tr'
            if tr_failure:
                tr.write_text('#!/bin/sh\nexit 7\n')
                tr.chmod(0o755)
            elif tr.exists():
                tr.unlink()
            args = ['docker', 'run', '--rm', '--entrypoint', 'sh',
                    '-e', 'TURN_REALM=turn.test.example', '-e', 'PATH=/testbin:/usr/bin:/bin',
                    '-v', f'{stub}:/testbin:ro',
                    '-v', f'{ROOT / "deploy/coturn"}:/opt/circlus:ro']
            if secret_path:
                args += ['-v', f'{secret_path}:/run/secrets/turn_local:ro']
            if group is not None:
                args += ['--group-add', str(group)]
            return run(args + [IMAGE, '/opt/circlus/start-coturn.sh'], ok=False, timeout=15)

        group = secret.stat().st_gid
        good = probe(secret, group)
        assert good.returncode == 0 and 'STARTED' in good.stdout, good.stdout
        for name, content in [('empty', b''), ('newlines', b'\r\n')]:
            bad = base / name
            bad.write_bytes(content)
            bad.chmod(0o644)
            failed = probe(bad)
            assert failed.returncode != 0 and 'STARTED' not in failed.stdout, failed.stdout
        for failed in (probe(None), probe(secret, group, tr_failure=True)):
            assert failed.returncode != 0 and 'STARTED' not in failed.stdout, failed.stdout
        print('PASS: missing/empty secrets and failed reads prevent startup; runtime config is private', flush=True)

        root_fixture = base / 'root-install'
        prepare(root_fixture)
        try:
            run(['docker', 'run', '--rm', '--user', '0:0', '--entrypoint', 'sh',
                 '-v', f'{root_fixture}:/work', '-w', '/work', IMAGE, 'deploy/init-local-turn.sh'])
            root_secret = root_fixture / 'deploy/secrets/turn-local.secret'
            failed = probe(root_secret)
            assert failed.returncode != 0 and 'unreadable' in failed.stdout, failed.stdout
            good = probe(root_secret, 0)
            assert good.returncode == 0 and 'STARTED' in good.stdout, good.stdout
        finally:
            run(['docker', 'run', '--rm', '--user', '0:0', '--entrypoint', 'chown',
                 '-v', f'{root_fixture}:/work', IMAGE, '-R', f'{os.getuid()}:{os.getgid()}', '/work'])
        print('PASS: root installation remains readable to non-root coturn only with the configured group', flush=True)

        # Use this machine's non-loopback address, without sending any traffic.
        # Loopback relay peers are deliberately forbidden by the production config.
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(('192.0.2.1', 9))
            address = sock.getsockname()[0]
        turn_port, ice_port = available_port(), available_port()
        env_file = stack / 'deploy/.env'
        env_file.write_text(env_file.read_text().replace('TURN_LISTEN_PORT=3478', f'TURN_LISTEN_PORT={turn_port}')
                            .replace('ICE_CONFIG_HOST_PORT=3090', f'ICE_CONFIG_HOST_PORT={ice_port}')
                            .replace('TURN_RELAY_MIN_PORT=49160', 'TURN_RELAY_MIN_PORT=56000')
                            .replace('TURN_RELAY_MAX_PORT=49200', 'TURN_RELAY_MAX_PORT=56040'))
        config_file = stack / 'deploy/ice/turn-clusters.json'
        config_file.write_text(config_file.read_text().replace('turn.test.example:3478', f'{address}:{turn_port}'))
        shutil.copy(ROOT / 'compose.yaml', stack / 'compose.yaml')
        shutil.copytree(ROOT / 'ice_config_service', stack / 'ice_config_service',
                        ignore=shutil.ignore_patterns('node_modules', 'dist', '.env', 'secrets', 'config.local.json'))
        project = 'circlus-turn-test-' + uuid.uuid4().hex[:10]
        environment = {**os.environ, 'COMPOSE_PROJECT_NAME': project}
        compose = ['docker', 'compose', '--env-file', 'deploy/.env', '--profile', 'local-turn']
        try:
            run(compose + ['config', '--quiet'], cwd=stack, env=environment)
            run(compose + ['up', '-d', '--build', '--wait', '--wait-timeout', '60', 'ice-config-service', 'coturn'],
                cwd=stack, env=environment, timeout=240)
            run(['node', 'deploy/smoke-test-ice.mjs'], cwd=stack, env=environment)
            run(['node', 'deploy/smoke-test-ice.mjs'], cwd=stack,
                env={**environment, 'ICE_SMOKE_TURN_CLUSTER_ID': ''})
            result = run(['node', 'deploy/smoke-test-turn.mjs'], cwd=stack, env=environment)
            print(result.stdout, flush=True)
            credential_file = stack / 'credentials.json'
            run(['node', 'deploy/smoke-test-turn.mjs', '--write-credentials', str(credential_file)], cwd=stack, env=environment)
            assert credential_file.stat().st_mode & 0o777 == 0o600
            credentials = json.loads(credential_file.read_text())
            assert original.strip().decode() not in credential_file.read_text()
            # An exit status of zero with missing packets must not pass.
            fake_client = stack / 'fake-client'
            fake_client.write_text('#!/bin/sh\necho "tot_send_msgs=40, tot_recv_msgs=0"\n')
            fake_client.chmod(0o755)
            failed = run(['node', 'deploy/smoke-test-turn.mjs', '--credentials', str(credential_file)],
                         cwd=stack, env={**environment, 'TURN_SMOKE_CLIENT': str(fake_client)}, ok=False)
            assert failed.returncode != 0, failed.stdout
            credentials['credential'] = 'deliberately-wrong-password'
            credential_file.write_text(json.dumps(credentials))
            failed = run(['node', 'deploy/smoke-test-turn.mjs', '--credentials', str(credential_file)],
                         cwd=stack, env=environment, ok=False)
            assert failed.returncode != 0, failed.stdout
            assert credentials['credential'] not in failed.stdout
            print('PASS: wrong TURN credentials fail the relay test without leaking credentials', flush=True)
        except Exception:
            print(run(compose + ['logs', '--tail=70', 'coturn', 'ice-config-service'],
                      cwd=stack, env=environment, ok=False).stdout, flush=True)
            raise
        finally:
            run(compose + ['down', '--volumes', '--remove-orphans'], cwd=stack, env=environment)


if __name__ == '__main__':
    main()
