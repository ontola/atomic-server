#!/usr/bin/env python3
"""Bounded CPU measurements on a dedicated CI worker. No argv or environment reads."""
from __future__ import annotations
import argparse
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import time

OWNED_SERVER = re.compile(r'^(atomic-server|atomic-managed)')


def parse_stat(text):
    end = text.rfind(')')
    start = text.find('(')
    fields = text[end + 2:].split()
    if start < 0 or end < start or len(fields) < 20:
        raise ValueError('unsupported process stat')
    return {'comm': text[start + 1:end], 'ticks': int(fields[11]) + int(fields[12]),
            'start_ticks': int(fields[19])}


def host_ticks(text):
    result = {}
    for line in text.splitlines():
        fields = line.split()
        if fields and re.fullmatch(r'cpu\d*', fields[0]):
            values = [int(v) for v in fields[1:9]]
            if len(values) != 8:
                raise ValueError('unsupported host CPU stat')
            result[fields[0]] = values
    if 'cpu' not in result:
        raise ValueError('host CPU aggregate is absent')
    return result


def cpu_delta(before, after):
    differences = [b - a for a, b in zip(before, after)]
    total = sum(differences)
    if total <= 0 or any(value < 0 for value in differences):
        return None
    pct = lambda value: round(value * 100 / total, 4)
    return {'busy_percent': pct(sum(differences[i] for i in (0, 1, 2, 5, 6))),
            'idle_percent': pct(differences[3]), 'iowait_percent': pct(differences[4]),
            'steal_percent': pct(differences[7])}


def cpu_capacity(pid, proc=Path('/proc'), cgroups=Path('/sys/fs/cgroup')):
    """Effective affinity/quota facts, without retaining a cgroup's private name."""
    affinity = len(os.sched_getaffinity(pid))
    relative = None
    for line in (proc / str(pid) / 'cgroup').read_text().splitlines():
        if line.startswith('0::'):
            relative = line[3:]
    quotas = []
    if relative is not None:
        relative = Path(relative.lstrip('/'))
        if '..' in relative.parts:
            raise ValueError('unsafe cgroup path')
        current = cgroups / relative
        while True:
            limit = current / 'cpu.max'
            if limit.is_file():
                quota, period = limit.read_text().split()
                if quota != 'max':
                    quotas.append(int(quota) / int(period))
            if current == cgroups:
                break
            current = current.parent
    return {'affinity_cpus': affinity, 'quota_cpus': min(quotas) if quotas else None}


def snapshot(proc=Path('/proc')):
    servers = {}
    errors = 0
    for directory in proc.iterdir():
        if not directory.name.isdigit():
            continue
        try:
            stat = parse_stat((directory / 'stat').read_text())
            if not OWNED_SERVER.match(stat['comm']):
                continue
            if len(servers) >= 128:
                errors += 1
                continue
            pid = int(directory.name)
            stat.update(cpu_capacity(pid, proc), pid=pid)
            threads = {}
            for thread in (directory / 'task').iterdir():
                if len(threads) >= 512:
                    errors += 1
                    break
                try:
                    sample = parse_stat((thread / 'stat').read_text())
                    # Retain only numeric thread identity/counters, not arbitrary names.
                    sample.pop('comm')
                    threads[int(thread.name)] = sample
                except (OSError, ValueError):
                    continue  # A thread can exit between directory listing and read.
            stat['threads'] = threads
            servers[(pid, stat['start_ticks'])] = stat
        except (OSError, ValueError):
            continue
    pressure = {}
    for resource in ('cpu', 'io', 'memory'):
        try:
            rows = {}
            for line in (proc / 'pressure' / resource).read_text().splitlines():
                kind, *values = line.split()
                rows[kind] = {key: float(value) for key, value in (v.split('=') for v in values)}
            pressure[resource] = rows
        except (OSError, ValueError):
            pass
    return {'monotonic': time.monotonic(), 'at': dt.datetime.now(dt.timezone.utc).isoformat(),
            'host': host_ticks((proc / 'stat').read_text()), 'servers': servers,
            'pressure': pressure, 'truncated_process_or_thread_inventories': errors}


def measurement(before, after, hz):
    seconds = after['monotonic'] - before['monotonic']
    if seconds <= 0 or hz <= 0:
        raise ValueError('invalid measurement interval')
    cpus = len(after['host']) - 1
    hosts = {key: cpu_delta(before['host'][key], value)
             for key, value in after['host'].items() if key in before['host']}
    processes = []
    for identity, value in after['servers'].items():
        old = before['servers'].get(identity)
        row = {key: value[key] for key in ('pid', 'comm', 'start_ticks', 'affinity_cpus', 'quota_cpus')}
        row['cpu_percent_one_core'] = None
        row['threads'] = []
        if old is not None and value['ticks'] >= old['ticks']:
            row['cpu_percent_one_core'] = round((value['ticks'] - old['ticks']) * 100 / hz / seconds, 4)
            for tid, thread in value['threads'].items():
                prior = old['threads'].get(tid)
                if prior and prior['start_ticks'] == thread['start_ticks'] and thread['ticks'] >= prior['ticks']:
                    row['threads'].append({'tid': tid, 'cpu_percent_one_core': round(
                        (thread['ticks'] - prior['ticks']) * 100 / hz / seconds, 4)})
        processes.append(row)
    return {'version': 1, 'sample_at': after['at'], 'interval_seconds': seconds,
            'visible_host_cpus': cpus, 'host_cpu': hosts, 'server_process_count': len(processes),
            'server_processes': processes, 'pressure': after['pressure'],
            'truncated_process_or_thread_inventories': after['truncated_process_or_thread_inventories']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--deadline', required=True)
    parser.add_argument('--interval', type=int, default=20)
    args = parser.parse_args()
    deadline = dt.datetime.fromisoformat(args.deadline.replace('Z', '+00:00'))
    if deadline.utcoffset() is None or not 5 <= args.interval <= 60:
        raise ValueError('finite deadline and 5-60 second interval required')
    if not args.output.is_absolute() or args.output.exists() or args.output.is_symlink() or any(p.is_symlink() for p in args.output.parents):
        raise ValueError('sampler output must be a new absolute regular file')
    args.output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    previous = snapshot()
    hz = os.sysconf('SC_CLK_TCK')
    lock_path = args.output.with_name(args.output.name + '.lock')
    if lock_path.is_symlink():
        raise ValueError('sampler lock cannot be a symlink')
    with args.output.open('x') as stream, lock_path.open('a') as lock:
        os.chmod(args.output, 0o600)
        os.chmod(lock_path, 0o600)
        while True:
            remaining = (deadline - dt.datetime.now(dt.timezone.utc)).total_seconds()
            if remaining <= 0:
                return
            time.sleep(min(args.interval, remaining))
            current = snapshot()
            item = measurement(previous, current, hz)
            mount = '/mnt/atomic-ci' if Path('/mnt/atomic-ci').is_mount() else '/'
            disk = os.statvfs(mount)
            item['disk_bytes'] = {'mount': mount, 'total': disk.f_blocks * disk.f_frsize, 'available': disk.f_bavail * disk.f_frsize}
            # Retrieval holds this same lock shared for the complete tar read.
            # Keep the measurement window running while preventing a partial row
            # or "file changed as read" from invalidating report collection.
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                stream.write(json.dumps(item, separators=(',', ':')) + '\n'); stream.flush()
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
            previous = current


if __name__ == '__main__':
    main()
