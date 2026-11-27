#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sampler', Path(__file__).with_name('ci-resource-sampler.py'))
sampler = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sampler)


class SamplerTests(unittest.TestCase):
    def stat(self, comm, ticks, start):
        fields = ['0'] * 25
        fields[0] = 'S'
        fields[11] = str(ticks - 3)
        fields[12] = '3'
        fields[19] = str(start)
        return '123 (' + comm + ') ' + ' '.join(fields)

    def test_stat_parser_handles_spaces_and_parentheses_without_reading_argv(self):
        self.assertEqual(sampler.parse_stat(self.stat('atomic-server (x)', 22, 10)),
                         {'comm': 'atomic-server (x)', 'ticks': 22, 'start_ticks': 10})

    def test_guest_ticks_are_not_double_counted_and_io_wait_is_separate(self):
        before = sampler.host_ticks('cpu 10 0 10 100 5 0 0 0 8 0\ncpu0 10 0 10 100 5 0 0 0 8 0')
        after = sampler.host_ticks('cpu 30 0 10 120 15 0 0 0 20 0\ncpu0 30 0 10 120 15 0 0 0 20 0')
        self.assertEqual(sampler.cpu_delta(before['cpu'], after['cpu']),
                         {'busy_percent': 40.0, 'idle_percent': 40.0, 'iowait_percent': 20.0, 'steal_percent': 0.0})
        self.assertIsNone(sampler.cpu_delta(after['cpu'], before['cpu']))

    def sample(self, monotonic, pid_start=7, tid_start=8, ticks=100):
        return {'monotonic': monotonic, 'at': '2026-11-27T00:00:00+00:00',
            'host': {'cpu': [ticks, 0, 0, ticks, 0, 0, 0, 0], 'cpu0': [ticks, 0, 0, ticks, 0, 0, 0, 0]},
            'servers': {(123, pid_start): {'pid': 123, 'comm': 'atomic-server-b', 'ticks': ticks,
                'start_ticks': pid_start, 'affinity_cpus': 1, 'quota_cpus': 0.5,
                'threads': {124: {'start_ticks': tid_start, 'ticks': ticks}}}},
            'pressure': {}, 'truncated_process_or_thread_inventories': 0}

    def test_process_and_thread_cpu_use_interval_and_real_clock_hz(self):
        record = sampler.measurement(self.sample(10), self.sample(12, ticks=200), 100)
        self.assertEqual(record['server_processes'][0]['cpu_percent_one_core'], 50.0)
        self.assertEqual(record['server_processes'][0]['threads'], [{'tid': 124, 'cpu_percent_one_core': 50.0}])
        self.assertEqual(record['server_processes'][0]['quota_cpus'], 0.5)
        self.assertEqual(record['server_process_count'], 1)

    def test_pid_and_tid_reuse_never_create_false_cpu_spikes(self):
        record = sampler.measurement(self.sample(10), self.sample(12, pid_start=100, ticks=10000), 100)
        self.assertIsNone(record['server_processes'][0]['cpu_percent_one_core'])
        record = sampler.measurement(self.sample(10), self.sample(12, tid_start=100, ticks=10000), 100)
        self.assertEqual(record['server_processes'][0]['threads'], [])


if __name__ == '__main__':
    unittest.main()
