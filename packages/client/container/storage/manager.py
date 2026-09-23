"""Trusted daemon-side fixed filesystem manager. Never run inside a caller.

The pool lock covers admission, preallocation and loop attachment across agents.
Incomplete allocations are quarantined until explicit deletion, never reformatted.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def syncdir(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def main():
    action, key, uuid, size, budget, reserve = sys.argv[1:]
    require(action in ('create', 'attach', 'check', 'delete'), 'invalid action')
    require(re.fullmatch(r'[a-f0-9]{64}', key), 'invalid storage key')
    require(re.fullmatch(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', uuid), 'invalid UUID')
    size, budget, reserve = map(int, (size, budget, reserve))
    require(64 * 1048576 <= size <= 65536 * 1048576 and budget >= size and reserve >= 0, 'invalid capacity')
    os.umask(0o077)
    root = Path('/pool/managed')
    root.mkdir(exist_ok=True)
    require(not root.is_symlink(), 'symlink pool directory')
    with open(root / 'lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        db = sqlite3.connect(root / 'catalog.sqlite')
        db.execute('PRAGMA synchronous=FULL')
        db.execute('CREATE TABLE IF NOT EXISTS policy (budget INTEGER, reserve INTEGER)')
        db.execute('CREATE TABLE IF NOT EXISTS images (key TEXT PRIMARY KEY, uuid TEXT UNIQUE, size INTEGER, state TEXT)')
        policy = db.execute('SELECT budget,reserve FROM policy').fetchone()
        if policy is None:
            db.execute('INSERT INTO policy VALUES (?,?)', (budget, reserve))
        else:
            require(policy == (budget, reserve), 'pool policy differs from existing catalog')
        db.commit()
        syncdir(root)
        row = db.execute('SELECT uuid,size,state FROM images WHERE key=?', (key,)).fetchone()
        image = root / (key + '.img')
        require(not image.is_symlink(), 'symlink image')
        if row:
            require(row[:2] == (uuid, size), 'retained storage identity/capacity mismatch')
        elif action == 'delete':
            require(not image.exists(), 'unrecorded image; inspect pool')
            return
        elif action == 'create':
            require(not image.exists(), 'unrecorded image; inspect pool')
            used = db.execute('SELECT coalesce(sum(size),0) FROM images').fetchone()[0]
            space = os.statvfs(root)
            require(used + size <= budget, 'pool capacity exhausted')
            require(space.f_bavail * space.f_frsize >= size + reserve, 'pool free-space reserve would be exhausted')
            db.execute('INSERT INTO images VALUES (?,?,?,?)', (key, uuid, size, 'allocating'))
            db.commit()
            # An interrupted operation leaves its intent charged to the pool.
            with open(image, 'xb') as f:
                os.posix_fallocate(f.fileno(), 0, size)
                os.fsync(f.fileno())
            syncdir(root)
            run('mkfs.ext4', '-q', '-F', '-b', '4096', '-i', '16384', '-m', '0',
                '-U', uuid, '-E', 'nodiscard,lazy_itable_init=0,lazy_journal_init=0', str(image))
            mount = Path('/mnt/image')
            mount.mkdir(parents=True, exist_ok=True)
            loop = run('losetup', '--find', '--show', '--nooverlap', str(image))
            try:
                run('mount', '-t', 'ext4', '-o', 'nodev,nosuid,nodiscard', loop, str(mount))
                try:
                    for directory in ('workspace', 'sessions', 'sessions/config'):
                        target = mount / directory
                        target.mkdir(mode=0o700)
                        os.chown(target, 1000, 1000)
                    run('sync', '-f', str(mount))
                finally:
                    run('umount', str(mount))
            finally:
                run('losetup', '-d', loop)
            with open(image, 'rb') as f:
                os.fsync(f.fileno())
            require(image.stat().st_blocks * 512 >= size, 'backing filesystem did not retain allocation')
            db.execute("UPDATE images SET state='ready' WHERE key=?", (key,))
            db.commit()
            row = (uuid, size, 'ready')
        else:
            raise RuntimeError('retained storage catalog entry missing')

        alias = Path('/dev/disk/by-uuid') / uuid
        if action == 'delete':
            # The client first removes all validated Docker consumers and volume.
            if image.exists():
                if alias.is_symlink():
                    require(re.fullmatch(r'/dev/loop[0-9]+', os.readlink(alias)), 'unexpected UUID alias target')
                loops = run('losetup', '-j', str(image)).splitlines()
                for line in loops:
                    loop = line.split(':', 1)[0]
                    run('losetup', '-d', loop)
                    for _ in range(50):
                        if not run('losetup', '-j', str(image)):
                            break
                        time.sleep(0.1)
                    require(not run('losetup', '-j', str(image)), 'image still attached; deletion refused')
                if alias.is_symlink():
                    # After a crash this alias may point to a recycled loop
                    # belonging to another image. Remove only our UUID alias;
                    # detach only devices found by this image's backing inode.
                    alias.unlink()
                image.unlink()
                syncdir(root)
            db.execute('DELETE FROM images WHERE key=?', (key,))
            db.commit()
            return

        require(row[2] == 'ready', 'incomplete allocation; explicitly remove scope before retrying')
        require(image.is_file() and image.stat().st_size == size and image.stat().st_blocks * 512 >= size,
                'retained image missing, resized or no longer allocated')
        require(run('blkid', '-p', '-s', 'UUID', '-o', 'value', str(image)) == uuid, 'filesystem UUID mismatch')
        require(run('blkid', '-p', '-s', 'TYPE', '-o', 'value', str(image)) == 'ext4', 'filesystem type mismatch')
        if action == 'check':
            return
        loop = run('losetup', '--find', '--show', '--nooverlap', str(image))
        require(run('blkid', '-p', '-s', 'UUID', '-o', 'value', loop) == uuid, 'attached device UUID mismatch')
        alias.parent.mkdir(parents=True, exist_ok=True)
        if alias.is_symlink():
            # Loop numbers can be reused after reboot. Replace only the alias;
            # never detach or modify the device its stale target points to.
            require(re.fullmatch(r'/dev/loop[0-9]+', os.readlink(alias)), 'unexpected UUID alias target')
            alias.unlink()
        else:
            require(not alias.exists(), 'UUID alias is not a symlink')
        alias.symlink_to(loop)
        print(json.dumps({'uuid': uuid, 'bytes': size}))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
