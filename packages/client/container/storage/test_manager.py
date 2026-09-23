"""Unprivileged recovery regression tests; Linux tools are mocked at their boundary."""
import importlib.util
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('storage_manager', Path(__file__).with_name('manager.py'))
manager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manager)


class DeleteRecoveryTest(unittest.TestCase):
    def test_interrupted_delete_with_recycled_loop_keeps_other_device(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            managed = root / 'managed'
            managed.mkdir()
            key = 'a' * 64
            uuid = '12345678-1234-1234-1234-123456789abc'
            image = managed / (key + '.img')
            image.write_bytes(b'retained')
            alias = root / 'dev/disk/by-uuid' / uuid
            alias.parent.mkdir(parents=True)
            alias.symlink_to('/dev/loop7')
            size, budget, reserve = 64 * 1048576, 128 * 1048576, 64 * 1048576
            with sqlite3.connect(managed / 'catalog.sqlite') as db:
                db.execute('CREATE TABLE policy (budget INTEGER, reserve INTEGER)')
                db.execute('INSERT INTO policy VALUES (?,?)', (budget, reserve))
                db.execute('CREATE TABLE images (key TEXT PRIMARY KEY, uuid TEXT UNIQUE, size INTEGER, state TEXT)')
                db.execute('INSERT INTO images VALUES (?,?,?,?)', (key, uuid, size, 'ready'))
            attached = True
            crash = True
            detached = []

            def linux(*args):
                nonlocal attached
                if args == ('losetup', '-j', str(image)):
                    return '/dev/loop7: []: (' + str(image) + ')' if attached else ''
                if args == ('losetup', '-d', '/dev/loop7'):
                    self.assertTrue(attached, 'must not detach the recycled device owned by B')
                    attached = False
                    detached.append('/dev/loop7')
                    if crash:
                        raise RuntimeError('injected crash after detach')
                    return ''
                self.fail('unexpected Linux mutation: ' + repr(args))

            def path(value):
                if value == '/pool/managed':
                    return managed
                if value == '/dev/disk/by-uuid':
                    return alias.parent
                return Path(value)

            args = ['manager.py', 'delete', key, uuid, str(size), str(budget), str(reserve)]
            with patch.object(manager, 'Path', path), patch.object(manager, 'run', linux), patch.object(sys, 'argv', args):
                previous_umask = os.umask(0o077)
                try:
                    with self.assertRaisesRegex(RuntimeError, 'injected crash'):
                        manager.main()
                    self.assertTrue(image.exists())
                    self.assertTrue(alias.is_symlink())
                    crash = False
                    # loop7 is now attached to B. Querying whether it is attached
                    # at all cannot establish ownership of A's stale UUID alias.
                    with patch.object(manager.subprocess, 'run') as query_other:
                        query_other.return_value.returncode = 0
                        manager.main()
                        query_other.assert_not_called()
                finally:
                    os.umask(previous_umask)
            self.assertEqual(detached, ['/dev/loop7'])
            self.assertFalse(image.exists())
            self.assertFalse(alias.is_symlink())
            with sqlite3.connect(managed / 'catalog.sqlite') as db:
                self.assertEqual(db.execute('SELECT count(*) FROM images').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
