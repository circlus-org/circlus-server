#!/usr/bin/env python3
"""Cumulative release notes tested against an isolated real Git history."""
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('notes', Path(__file__).with_name('generate-release-notes.py'))
notes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notes)


class ReleaseNotesTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        previous = os.getcwd()
        self.addCleanup(os.chdir, previous)
        os.chdir(self.temp.name)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Fixture')
        self.git('config', 'user.email', 'fixture@example.invalid')
        self.git('config', 'commit.gpgsign', 'false')
        Path('server/db/migrations').mkdir(parents=True)
        for version in range(1, 5):
            Path(f'server/db/migrations/00{version}.sql').write_text(f'-- fixture {version}')
            self.git('add', '.')
            self.git('commit', '-qm', f'Change {version}')
            self.git('tag', f'v1.0.{version}')
        self.releases = [self.release(1, False), self.release(2, True), self.release(3, True), self.release(4, True)]

    def git(self, *args):
        subprocess.run(['git', *args], check=True, capture_output=True)

    def release(self, version, draft, prerelease=False):
        return dict(tag_name=f'v1.0.{version}', draft=draft, prerelease=prerelease,
                    published_at=f'2026-10-{version:02}T00:00:00Z',
                    body=f'## Changes\n\nEditorial {version}\n\n## Before updating\n\nSetting {version}\n\n## Database\n\nSTALE DATABASE\n\n## Images\n\nSTALE IMAGES')

    def test_skipped_drafts_are_cumulative(self):
        result = notes.generate('example/server', 'v1.0.3', self.releases)
        for expected in ['Change 2', 'Change 3', 'Editorial 2', 'Editorial 3', 'Setting 2', '002.sql', '003.sql', 'v1.0.1...v1.0.3']:
            self.assertIn(expected, result)
        for absent in ['Change 1', 'Change 4', 'Editorial 4', '001.sql', '004.sql', 'STALE']:
            self.assertNotIn(absent, result)

    def test_new_publication_advances_base(self):
        self.releases[1]['draft'] = False
        result = notes.generate('example/server', 'v1.0.3', self.releases)
        self.assertIn('v1.0.2...v1.0.3', result)
        self.assertNotIn('Change 2', result)
        self.assertNotIn('Editorial 2', result)

    def test_prerelease_does_not_advance_stable_base(self):
        self.releases[1].update(draft=False, prerelease=True)
        result = notes.generate('example/server', 'v1.0.3', self.releases)
        self.assertIn('Change 2', result)
        self.assertIn('v1.0.1...v1.0.3', result)

    def test_first_release_includes_entire_history(self):
        result = notes.generate('example/server', 'v1.0.3', [r for r in self.releases if r['draft']])
        self.assertIn('First stable release', result)
        self.assertIn('Change 1', result)
        self.assertIn('001.sql', result)

    def test_newer_publication_blocks_old_candidate(self):
        self.releases[3]['draft'] = False
        with self.assertRaises(ValueError):
            notes.generate('example/server', 'v1.0.3', self.releases)


if __name__ == '__main__':
    unittest.main()
