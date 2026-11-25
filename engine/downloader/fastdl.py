"""Parallel downloading for the Visubly engine (stdlib + the system curl.exe only).

- curl_parallel(): one curl process with --parallel, so connections are reused instead of
  starting a new curl (and a new TLS handshake) for every HLS segment.
- localize_playlist(): turns a media playlist into a local one: every segment, init map
  (EXT-X-MAP) and AES-128 key (EXT-X-KEY) is downloaded in parallel and the playlist is
  rewritten to point at the local files, so ffmpeg only remuxes/decrypts from disk.
- download_ranges(): IDM-style multi-connection download of one big file (direct MP4) via
  HTTP Range, when the server supports it.

Failures are retried with fewer connections (servers that limit connections answer 429/403),
then one by one.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path
from typing import Callable

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
CONNECT_TIMEOUT = 10
SPEED_LIMIT = 1024  # bytes/s ...
SPEED_TIME = 20  # ... for this long = stalled transfer, curl gives up on it
THROTTLE_CODES = ("429", "403", "503")
THROTTLE_ABORT = 3  # that many throttled answers in one pass -> retry with fewer connections
IDLE_ABORT = 45  # seconds with no new bytes and no finished transfer -> stop curl (never hang)


class FastPathUnsupported(Exception):
    """The playlist needs something the local path can't do (live, SAMPLE-AES/DRM keys...)."""


def find_curl() -> str | None:
    # Windows' own curl first: other copies on PATH (e.g. Git's curl 8.19) can hang with
    # --parallel + --retry when a server answers 429.
    system = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "curl.exe")
    if os.path.isfile(system):
        return system
    return shutil.which("curl.exe") or shutil.which("curl")


def _quote(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def human_speed(bytes_per_sec: float) -> str:
    if bytes_per_sec <= 0:
        return ""
    mb = bytes_per_sec / (1024 * 1024)
    return f"{mb:.1f} MB/s" if mb >= 1 else f"{bytes_per_sec / 1024:.0f} KB/s"


def curl_parallel(
    jobs: list[tuple[str, Path, str | None]],
    header_lines: list[str],
    workers: int,
    *,
    on_progress: Callable[[int, int, float], None] | None = None,
    work_dir: Path,
) -> set[int]:
    """Downloads jobs (url, output path, optional byte range "a-b") with one curl --parallel.

    Returns the indexes that failed. on_progress(done, total, bytes_per_sec) is called about
    twice a second while curl runs.
    """
    curl = find_curl()
    if not curl:
        raise RuntimeError("curl.exe not found")
    if not jobs:
        return set()
    config = work_dir / f"curl-{os.getpid()}-{int(time.time() * 1000)}.txt"
    # One block per transfer, separated by "next": options such as range are per transfer, and a
    # flat config would apply the last range to every URL. Headers (cookies) live in the config
    # file too, so they never show up in the process list.
    per_transfer = [
        "location", "fail",
        f"connect-timeout = {CONNECT_TIMEOUT}",
        f"speed-limit = {SPEED_LIMIT}", f"speed-time = {SPEED_TIME}",
        "retry = 2", "retry-delay = 1",
        'write-out = "%{exitcode} %{http_code} %{filename_effective}\\n"',
    ] + [f"header = {_quote(h)}" for h in header_lines]
    blocks = []
    for url, out, rng in jobs:
        block = [f"url = {_quote(url)}", f"output = {_quote(str(out).replace(chr(92), '/'))}"]
        if rng:
            block.append(f"range = {rng}")
        blocks.append("\n".join(block + per_transfer))
    config.write_text("\nnext\n".join(blocks) + "\n", encoding="utf-8")
    command = [
        curl, "--parallel", "--parallel-max", str(max(1, min(workers, 32))), "--parallel-immediate",
        "--silent", "--show-error",
        "-K", str(config),
    ]

    by_output = {str(out).replace("\\", "/").lower(): index for index, (_, out, _) in enumerate(jobs)}
    ok: set[int] = set()
    failed: set[int] = set()
    throttled = [0]  # 429/403/503 answers: the server limits connections
    lock = threading.Lock()

    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                               text=True, encoding="utf-8", errors="replace", creationflags=NO_WINDOW)

    def reader() -> None:
        assert process.stdout is not None
        for raw in process.stdout:
            parts = raw.strip().split(" ", 2)
            if len(parts) < 3:
                continue
            index = by_output.get(parts[2].replace("\\", "/").lower())
            if index is None:
                continue
            with lock:
                if parts[0] == "0":
                    ok.add(index)
                else:
                    failed.add(index)
                    if parts[1] in THROTTLE_CODES:
                        throttled[0] += 1

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()
    last_bytes, last_time = 0, time.time()
    last_activity, last_seen = time.time(), (0, 0)
    while process.poll() is None:
        time.sleep(0.5)
        with lock:
            # A few stray 429s are fine (the next pass picks them up); abort only when throttling
            # is a real share of the answers.
            too_many = workers > 1 and throttled[0] >= THROTTLE_ABORT and throttled[0] * 4 >= len(ok)
            finished = len(ok) + len(failed)
        total = 0
        for _, out, _ in jobs:
            try:
                total += out.stat().st_size
            except OSError:
                pass
        now = time.time()
        if (total, finished) != last_seen:
            last_seen, last_activity = (total, finished), now
        if too_many or now - last_activity > IDLE_ABORT:
            # Too many 429s (pushing on only collects more) or curl stuck: stop it; whatever is not
            # done is retried by the caller with fewer connections.
            process.terminate()
            process.wait()
            break
        if on_progress:
            rate = (total - last_bytes) / max(0.001, now - last_time)
            last_bytes, last_time = total, now
            with lock:
                done = len(ok)
            on_progress(done, len(jobs), rate)
    thread.join(timeout=5)
    try:
        config.unlink()
    except OSError:
        pass
    # Anything curl did not report as OK (killed, never started...) counts as failed.
    return {i for i in range(len(jobs)) if i not in ok or not jobs[i][1].exists()} | failed


def download_all(
    jobs: list[tuple[str, Path, str | None]],
    header_lines: list[str],
    workers: int,
    *,
    work_dir: Path,
    fetch_one: Callable[[str, str | None], bytes] | None = None,
    on_progress: Callable[[int, int, float], None] | None = None,
    on_retry: Callable[[int, int, int], None] | None = None,
) -> None:
    """curl_parallel + back-off: retry failures with half the connections, then a single
    connection, then fetch_one (must raise on HTTP errors) one by one.
    on_retry(failed_count, total, next_connections) is called before each retry pass."""
    total = len(jobs)
    pending = list(range(total))
    plan = [workers, max(2, workers // 2), 1]
    for attempt, conns in enumerate(plan):
        if attempt and on_retry:
            on_retry(len(pending), total, conns)
        subset = [jobs[i] for i in pending]

        def progress(done: int, _total: int, rate: float, base=total - len(pending)) -> None:
            if on_progress:
                on_progress(base + done, total, rate)

        failed_local = curl_parallel(subset, header_lines, conns, on_progress=progress, work_dir=work_dir)
        pending = [pending[i] for i in sorted(failed_local)]
        if not pending:
            return
        time.sleep(1.5 * (attempt + 1))
    if fetch_one is None:
        raise RuntimeError(f"{len(pending)} of {total} downloads failed")
    for count, index in enumerate(pending, start=1):
        url, out, rng = jobs[index]
        out.write_bytes(fetch_one(url, rng))
        if on_progress:
            on_progress(total - len(pending) + count, total, 0.0)


# ---------- HLS: local playlist ----------

URI_ATTR = re.compile(r'URI="([^"]*)"')


def localize_playlist(playlist_url: str, playlist_text: str, folder: Path) -> tuple[Path, list[tuple[str, Path, str | None]]]:
    """Rewrites a media playlist so every URI points to a local file; returns (local m3u8, jobs)."""
    if "#EXTM3U" not in playlist_text[:1024]:
        raise FastPathUnsupported("not an HLS playlist")
    if "#EXT-X-STREAM-INF" in playlist_text:
        raise FastPathUnsupported("master playlist")
    if "#EXT-X-ENDLIST" not in playlist_text:
        raise FastPathUnsupported("live playlist")
    files: dict[str, Path] = {}
    jobs: list[tuple[str, Path, str | None]] = []

    def local_for(uri: str) -> str:
        absolute = urllib.parse.urljoin(playlist_url, uri.strip())
        if absolute not in files:
            ext = Path(urllib.parse.urlparse(absolute).path).suffix.lower()
            ext = ext if re.fullmatch(r"\.[a-z0-9]{1,5}", ext or "") else ".bin"
            path = folder / f"r{len(files):06d}{ext}"
            files[absolute] = path
            jobs.append((absolute, path, None))
        return files[absolute].name

    out_lines = []
    for raw in playlist_text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-KEY") or line.startswith("#EXT-X-SESSION-KEY"):
            method = re.search(r"METHOD=([A-Z0-9-]+)", line)
            method = method.group(1) if method else "NONE"
            if method not in ("NONE", "AES-128"):
                raise FastPathUnsupported(f"key method {method}")
            match = URI_ATTR.search(line)
            if match and method == "AES-128":
                uri = match.group(1)
                if not re.match(r"^(https?:|/|[^:]+$)", uri):
                    raise FastPathUnsupported("non-http key")
                line = line.replace(match.group(0), f'URI="{local_for(uri)}"')
            out_lines.append(line)
        elif line.startswith("#EXT-X-MAP"):
            match = URI_ATTR.search(line)
            if match:
                line = line.replace(match.group(0), f'URI="{local_for(match.group(1))}"')
            out_lines.append(line)
        elif line.startswith("#"):
            out_lines.append(line)
        else:
            out_lines.append(local_for(line))
    if not jobs:
        raise FastPathUnsupported("no segments")
    local = folder / "local.m3u8"
    local.write_text("\n".join(out_lines) + "\n", encoding="utf-8")
    return local, jobs


# ---------- direct files: multi-range ----------

def probe_ranges(url: str, header_lines: list[str]) -> tuple[int, bool]:
    """(size in bytes, supports ranges) using a 1-byte range request."""
    curl = find_curl()
    if not curl:
        return 0, False
    # --max-filesize: a server that ignores the range answers 200 with the whole file; curl then
    # stops right after the headers instead of downloading until --max-time.
    command = [curl, "-L", "--silent", "--show-error", "--connect-timeout", str(CONNECT_TIMEOUT), "--max-time", "20",
               "--max-filesize", "65536", "-r", "0-0", "-o", os.devnull, "-D", "-", url]
    for header in header_lines:
        command.extend(["-H", header])
    try:
        out = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30, creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.TimeoutExpired):
        return 0, False
    # Only the last response block counts (redirects come first).
    block = out.strip().split("\r\n\r\n")[-1] if "\r\n\r\n" in out.strip() else out
    status = re.search(r"^HTTP/\S+\s+(\d{3})", block, re.M)
    total = re.search(r"^content-range:\s*bytes\s+\d+-\d+/(\d+)", block, re.M | re.I)
    if status and status.group(1) == "206" and total:
        return int(total.group(1)), True
    length = re.search(r"^content-length:\s*(\d+)", block, re.M | re.I)
    return (int(length.group(1)) if length else 0), False


def download_ranges(
    url: str,
    header_lines: list[str],
    size: int,
    output: Path,
    parts: int,
    *,
    work_dir: Path,
    on_progress: Callable[[int, int, float], None] | None = None,
    fetch_one: Callable[[str, str | None], bytes] | None = None,
    on_retry: Callable[[int, int, int], None] | None = None,
) -> None:
    """Splits [0, size) into `parts` ranges, downloads them in parallel, joins them into output."""
    parts = max(1, min(parts, 16, size // (4 * 1024 * 1024) or 1))
    step = -(-size // parts)
    jobs = []
    for i in range(parts):
        start = i * step
        end = min(size, start + step) - 1
        if start > end:
            break
        jobs.append((url, work_dir / f"part{i:02d}.bin", f"{start}-{end}"))
    download_all(jobs, header_lines, parts, work_dir=work_dir, on_progress=on_progress,
                 fetch_one=fetch_one, on_retry=on_retry)
    got = sum(path.stat().st_size for _, path, _ in jobs)
    if got != size:
        raise RuntimeError(f"downloaded {got} of {size} bytes")
    tmp = output.with_name(output.name + ".part")
    with tmp.open("wb") as joined:
        for _, path, _ in jobs:
            with path.open("rb") as piece:
                shutil.copyfileobj(piece, joined, 4 * 1024 * 1024)
            path.unlink()
    os.replace(tmp, output)
