"""Offline tests for fastdl (no network): playlist rewriting and curl config blocks.

Run: python engine/downloader/test_fastdl.py
"""
from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import fastdl  # noqa: E402

BASE = "https://cdn.example/v/720/index.m3u8?sig=abc"


class LocalizePlaylist(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = pathlib.Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def localize(self, text: str):
        local, jobs = fastdl.localize_playlist(BASE, text, self.dir)
        return local.read_text(encoding="utf-8").splitlines(), jobs

    def test_ts_with_aes_key_and_relative_urls(self) -> None:
        lines, jobs = self.localize(
            "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:7\n"
            '#EXT-X-KEY:METHOD=AES-128,URI="../keys/k1.key?t=1",IV=0x0102\n'
            "#EXTINF:4,\nseg_0.ts?t=1\n#EXTINF:4,\n/abs/seg_1.ts\n#EXTINF:4,\nhttps://other.example/seg_2.ts\n"
            "#EXT-X-ENDLIST\n"
        )
        urls = [u for u, _, _ in jobs]
        self.assertEqual(urls, [
            "https://cdn.example/v/keys/k1.key?t=1",
            "https://cdn.example/v/720/seg_0.ts?t=1",
            "https://cdn.example/abs/seg_1.ts",
            "https://other.example/seg_2.ts",
        ])
        self.assertIn('#EXT-X-KEY:METHOD=AES-128,URI="r000000.key",IV=0x0102', lines)
        self.assertIn("#EXT-X-MEDIA-SEQUENCE:7", lines)  # IV derivation still works
        self.assertEqual([l for l in lines if not l.startswith("#")], ["r000001.ts", "r000002.ts", "r000003.ts"])
        self.assertTrue(all(p.parent == self.dir and r is None for _, p, r in jobs))

    def test_fmp4_map_byterange_and_discontinuity(self) -> None:
        lines, jobs = self.localize(
            "#EXTM3U\n#EXT-X-VERSION:7\n"
            '#EXT-X-MAP:URI="init.mp4",BYTERANGE="720@0"\n'
            "#EXTINF:4,\n#EXT-X-BYTERANGE:1000@720\nmedia.mp4\n"
            "#EXTINF:4,\n#EXT-X-BYTERANGE:1000@1720\nmedia.mp4\n"
            "#EXT-X-DISCONTINUITY\n#EXTINF:4,\nad.m4s\n#EXT-X-ENDLIST\n"
        )
        # Same resource referenced twice (byte ranges) is downloaded once; ranges stay in the playlist.
        self.assertEqual([u.rsplit("/", 1)[1] for u, _, _ in jobs], ["init.mp4", "media.mp4", "ad.m4s"])
        self.assertIn('#EXT-X-MAP:URI="r000000.mp4",BYTERANGE="720@0"', lines)
        self.assertEqual(lines.count("r000001.mp4"), 2)
        self.assertIn("#EXT-X-BYTERANGE:1000@1720", lines)
        self.assertIn("#EXT-X-DISCONTINUITY", lines)

    def test_odd_extensions_become_bin(self) -> None:
        _, jobs = self.localize("#EXTM3U\n#EXTINF:4,\nchunk\n#EXTINF:4,\nx.verylongext\n#EXT-X-ENDLIST\n")
        self.assertEqual([p.suffix for _, p, _ in jobs], [".bin", ".bin"])

    def test_unsupported_cases_fall_back(self) -> None:
        cases = {
            "live": "#EXTM3U\n#EXTINF:4,\na.ts\n",
            "master": "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv.m3u8\n#EXT-X-ENDLIST\n",
            "sample-aes": '#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n',
            "non-http key": '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST\n',
            "not hls": "<html>",
            "empty": "#EXTM3U\n#EXT-X-ENDLIST\n",
        }
        for name, text in cases.items():
            with self.subTest(name), self.assertRaises(fastdl.FastPathUnsupported):
                fastdl.localize_playlist(BASE, text, self.dir)


class CurlConfig(unittest.TestCase):
    def test_blocks_carry_their_own_range_and_headers(self) -> None:
        # Regression: a flat config applied the LAST range to every URL.
        captured = {}

        class FakeProc:
            stdout = iter(())

            def __init__(self, command, **_kw):
                cfg = pathlib.Path(command[command.index("-K") + 1])
                captured["command"] = command
                captured["config"] = cfg.read_text(encoding="utf-8")

            def poll(self):
                return 0

        real = fastdl.subprocess.Popen
        fastdl.subprocess.Popen = FakeProc
        try:
            with tempfile.TemporaryDirectory() as tmp:
                work = pathlib.Path(tmp)
                jobs = [("https://x.example/v.mp4", work / f"p{i}.bin", f"{i * 10}-{i * 10 + 9}") for i in range(3)]
                failed = fastdl.curl_parallel(jobs, ["Cookie: a=1", 'Referer: https://x.example/"q"'], 3, work_dir=work)
        finally:
            fastdl.subprocess.Popen = real
        blocks = captured["config"].strip().split("\nnext\n")
        self.assertEqual(len(blocks), 3)
        for i, block in enumerate(blocks):
            self.assertIn(f"range = {i * 10}-{i * 10 + 9}", block)
            self.assertIn('header = "Cookie: a=1"', block)
            self.assertIn('header = "Referer: https://x.example/\\"q\\""', block)
            self.assertIn("fail", block.splitlines())
        self.assertNotIn("-H", captured["command"])  # cookies stay out of the process list
        self.assertEqual(failed, {0, 1, 2})  # nothing reported OK -> all failed

    def test_human_speed(self) -> None:
        self.assertEqual(fastdl.human_speed(0), "")
        self.assertEqual(fastdl.human_speed(512 * 1024), "512 KB/s")
        self.assertEqual(fastdl.human_speed(3.5 * 1024 * 1024), "3.5 MB/s")


if __name__ == "__main__":
    unittest.main(verbosity=1)
