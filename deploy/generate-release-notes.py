#!/usr/bin/env python3
"""Generate cumulative draft notes; never publish or edit a release."""
import argparse
import json
import re
import subprocess


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def ancestor(before, after):
    return subprocess.run(['git', 'merge-base', '--is-ancestor', before, after],
                          check=False).returncode == 0


def sections(body):
    body = re.sub(r'<!--.*?-->', '', body or '', flags=re.S)
    # Preserve editorial Changes and upgrade instructions from skipped drafts.
    # Database/images are regenerated for the complete range and target tag.
    result = []
    for part in re.split(r'(?m)(?=^## )', body):
        heading = part.split('\n', 1)[0].strip().lower()
        if heading in ('## database', '## images'):
            continue
        if part.strip() and part.strip() not in ('## Changes', '## Before updating'):
            result.append(part.strip())
    return '\n\n'.join(result)


def generate(repo, tag, releases):
    target = run('git', 'rev-parse', '--verify', f'refs/tags/{tag}^{{commit}}')
    published = [r for r in releases if not r['draft'] and not r['prerelease']]
    previous = max(published, key=lambda r: r['published_at']) if published else None
    base = previous['tag_name'] if previous else None
    if base:
        base_commit = run('git', 'rev-parse', '--verify', f'refs/tags/{base}^{{commit}}')
        if base == tag or not ancestor(base_commit, target):
            raise ValueError('Last published release must precede the candidate tag')
    else:
        base_commit = None
    revision_range = f'{base_commit}..{target}' if base_commit else target
    changes = run('git', 'log', '--reverse', '--format=- %s (%h)', revision_range)
    notes = ['## Changes', f'Changes since `{base}`.' if base else 'First stable release.', changes]
    for release in sorted(releases, key=lambda r: r['tag_name']):
        if not release['draft']:
            continue
        candidate = run('git', 'rev-parse', '--verify', f"refs/tags/{release['tag_name']}^{{commit}}")
        if (ancestor(candidate, target)
                and (not base_commit or (candidate != base_commit and ancestor(base_commit, candidate)))):
            editorial = sections(release.get('body'))
            if editorial:
                notes += [f"### Notes from {release['tag_name']}", editorial]
    if base:
        files = run('git', 'diff', '--name-only', '--diff-filter=A', base_commit, target,
                    '--', 'server/db/migrations').splitlines()
    else:
        files = run('git', 'ls-tree', '-r', '--name-only', target,
                    '--', 'server/db/migrations').splitlines()
    migrations = [f'- `{name.rsplit("/", 1)[-1]}`' for name in files if name.endswith('.sql')]
    database = ('New migrations run automatically during the update:\n\n'
                + '\n'.join(migrations)
                + '\n\nTo roll back, restore the backup made before updating.') if migrations else 'No new migrations.'
    notes += ['<!-- Publisher: review cumulative changes, security fixes and Before updating instructions. -->',
              '## Database', database, '## Images',
              f'- `ghcr.io/{repo}:{tag}`\n- `ghcr.io/{repo}-ice-config-service:{tag}`',
              f'Follow the README with `CIRCLUS_IMAGE_TAG={tag}`.']
    if base:
        notes += [f'[Full comparison](https://github.com/{repo}/compare/{base}...{tag})']
    return '\n\n'.join(part for part in notes if part) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', required=True)
    parser.add_argument('--tag', required=True)
    args = parser.parse_args()
    # Failure to read releases is fatal: it must not masquerade as a first release.
    pages = json.loads(run('gh', 'api', '--paginate', '--slurp',
                          f'repos/{args.repo}/releases?per_page=100'))
    print(generate(args.repo, args.tag, [r for page in pages for r in page]), end='')
