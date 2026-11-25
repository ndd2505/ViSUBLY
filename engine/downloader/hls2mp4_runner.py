#!/usr/bin/env python3
"""JSON-lines runner for app/UI integrations around hls2mp4."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as _dt
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path
from typing import Any

import fastdl
import hls2mp4 as core


DEFAULT_TARGET_QUALITY = "1920x1080"


class EventEmitter:
    def __init__(self, event_log_file: str | None = None) -> None:
        self._handle = None
        if event_log_file:
            path = Path(event_log_file)
            path.parent.mkdir(parents=True, exist_ok=True)
            self._handle = path.open("a", encoding="utf-8", errors="replace")

    def emit(self, event: str, **payload: Any) -> None:
        record = {
            "event": event,
            "time": _dt.datetime.now(_dt.timezone.utc).isoformat(),
            **payload,
        }
        line = json.dumps(record, ensure_ascii=True, default=str)
        print(line, flush=True)
        if self._handle:
            self._handle.write(line + "\n")
            self._handle.flush()

    def close(self) -> None:
        if self._handle:
            self._handle.close()
            self._handle = None


@contextlib.contextmanager
def capture_core_logs(emitter: EventEmitter, phase: str):
    buffer = io.StringIO()
    try:
        with contextlib.redirect_stdout(buffer):
            yield
    finally:
        for line in buffer.getvalue().splitlines():
            message = line.strip()
            if message:
                emitter.emit("log", phase=phase, message=message)


def seconds_or_none(value: float | None) -> float | None:
    if value is None:
        return None
    return round(max(0.0, value), 3)


def first_word(value: str) -> str:
    stripped = value.lstrip()
    return stripped.split(maxsplit=1)[0].lower() if stripped else ""


def normalize_curl_command(value: str) -> str:
    stripped = value.lstrip()
    leading = value[: len(value) - len(stripped)]
    word = first_word(value)
    if word == "curl.exe":
        return leading + "curl" + stripped[len(word) :]
    return value


def read_source(args: argparse.Namespace) -> str:
    selected = sum(bool(value) for value in [args.source_file, args.source_stdin, args.source])
    if selected > 1:
        raise ValueError("Use only one source input: positional source, --source-file, or --source-stdin.")
    if args.source_file:
        return Path(args.source_file).read_text(encoding="utf-8-sig", errors="replace").strip()
    if args.source_stdin:
        # Read raw bytes so non-ASCII text (titles, cookies) survives any console code page.
        return sys.stdin.buffer.read().decode("utf-8-sig", errors="replace").strip()
    return " ".join(args.source).strip()


def load_item_file(path: str) -> dict[str, Any]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("Item file must contain a JSON object.")
    return normalize_item(data)


def normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    url = str(item.get("url") or "").strip()
    selected_url = str(item.get("selected_url") or item.get("selectedUrl") or url).strip()
    output = str(item.get("output") or "").strip()
    if not url:
        raise ValueError("Prepared item is missing url.")
    if not output:
        raise ValueError("Prepared item is missing output.")
    return {
        "id": str(item.get("id") or item.get("name") or Path(output).stem),
        "name": str(item.get("name") or Path(output).stem),
        "link_type": str(item.get("link_type") or item.get("type") or "m3u8"),
        "url": url,
        "headers": [str(header) for header in item.get("headers", [])],
        "selected_url": selected_url,
        "selected_quality": item.get("selected_quality") or item.get("selectedQuality"),
        "output": output,
        "workers": core.normalize_workers(int(item.get("workers") or core.DEFAULT_WORKERS)),
        "overwrite": bool(item.get("overwrite", False)),
        "variants": item.get("variants", []),
        "quality_status": item.get("quality_status"),
        "use_local_fallback": bool(item.get("use_local_fallback", False)),
        "segment_count": int(item.get("segment_count") or 0),
        "estimated_duration": item.get("estimated_duration"),
        "kind": item.get("kind"),
        "duration_sec": item.get("duration_sec"),
        "is_live": item.get("is_live"),
        "renditions": item.get("renditions", []),
    }


def parse_source_to_item(args: argparse.Namespace, emitter: EventEmitter) -> dict[str, Any]:
    raw_source = read_source(args)
    if not raw_source:
        raise ValueError("No URL or curl command provided.")

    curl_headers: list[str] = []
    input_kind = "url"
    source = raw_source.strip().strip('"')
    if first_word(source) in {"curl", "curl.exe"}:
        input_kind = "curl"
        source = normalize_curl_command(source)
        url, curl_headers = core.parse_curl(source)
        user_agent = None
    else:
        url = source
        user_agent = args.user_agent if args.user_agent else None

    if not url:
        raise ValueError("Could not find URL.")
    if url.startswith("blob:"):
        raise ValueError("Blob URLs cannot be downloaded. Use the real m3u8/mp4 URL from DevTools Network.")

    header_lines = core.ensure_browser_like_headers(
        core.build_header_lines(args.referer, user_agent, curl_headers + list(args.header or []))
    )
    selected_url = args.selected_url or url
    selected_quality = args.selected_quality
    variants: list[dict[str, Any]] = []
    renditions: list[str] = []
    quality_status = "provided" if args.selected_url else "not_checked"
    kind = {"m3u8": "media", "mp4": "mp4", "dash": "dash"}.get(args.type, str(args.type))
    duration_sec: float | None = None
    is_live: bool | None = None

    if args.type == "m3u8" and not args.selected_url:
        playlist_text = ""
        try:
            with capture_core_logs(emitter, "quality"):
                playlist_text = core.fetch_text(url, header_lines)
                variants = [dict(item) for item in core.parse_hls_variants(url, playlist_text)]
        except Exception as exc:
            emitter.emit("warning", phase="quality", message=f"Could not check HLS variants: {exc}")
            variants = []

        if variants:
            kind = "master"
            renditions = parse_hls_rendition_urls(url, playlist_text)
            selected, quality_status = select_variant(variants, args.target_quality)
            selected_url = str(selected["url"])
            selected_quality = str(selected.get("resolution") or "")
            # Duration/live state come from ONE media playlist (text only, never segments).
            richest = max(variants, key=lambda item: int(item.get("bandwidth") or 0))
            try:
                with capture_core_logs(emitter, "quality"):
                    duration_sec, is_live = hls_playlist_timing(core.fetch_text(str(richest["url"]), header_lines))
            except Exception as exc:
                emitter.emit("warning", phase="quality", message=f"Could not read the HLS media playlist: {exc}")
        else:
            quality_status = "no_variants"
            if playlist_text:
                duration_sec, is_live = hls_playlist_timing(playlist_text)
    elif args.type == "dash":
        try:
            with capture_core_logs(emitter, "quality"):
                duration_sec, is_live = dash_manifest_timing(core.fetch_text(url, header_lines))
        except Exception as exc:
            emitter.emit("warning", phase="quality", message=f"Could not read the DASH manifest: {exc}")

    output = Path(args.output) if args.output else core.output_path(selected_url, args.name)
    return {
        "id": args.item_id or Path(output).stem,
        "name": Path(output).stem,
        "input_kind": input_kind,
        "link_type": args.type,
        "url": url,
        "headers": header_lines,
        "selected_url": selected_url,
        "selected_quality": selected_quality,
        "output": str(output),
        "workers": core.normalize_workers(args.workers),
        "overwrite": bool(args.overwrite),
        "variants": variants,
        "quality_status": quality_status,
        "use_local_fallback": False,
        "segment_count": 0,
        "estimated_duration": None,
        "kind": kind,
        "duration_sec": seconds_or_none(duration_sec),
        "is_live": is_live,
        "renditions": renditions,
    }


def hls_playlist_timing(playlist_text: str) -> tuple[float | None, bool | None]:
    """(sum of #EXTINF, is_live) for a media playlist; (None, None) if it is not one."""
    if "#EXTM3U" not in playlist_text[:1024] and "#EXTINF" not in playlist_text:
        return None, None
    total = 0.0
    has_endlist = False
    is_vod = False
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if line.startswith("#EXTINF:"):
            try:
                total += float(line.split(":", 1)[1].split(",", 1)[0])
            except ValueError:
                pass
        elif line.startswith("#EXT-X-ENDLIST"):
            has_endlist = True
        elif line.upper().startswith("#EXT-X-PLAYLIST-TYPE:VOD"):
            is_vod = True
    return (total or None), not (has_endlist or is_vod)


def parse_hls_rendition_urls(master_url: str, playlist_text: str) -> list[str]:
    """Absolute URIs of #EXT-X-MEDIA renditions (alternate audio/subtitle playlists)."""
    urls: list[str] = []
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if not line.startswith("#EXT-X-MEDIA:"):
            continue
        uri = core.parse_stream_inf(line.split(":", 1)[1]).get("URI")
        if uri:
            urls.append(urllib.parse.urljoin(master_url, uri))
    return urls


def parse_iso8601_duration(value: str) -> float | None:
    match = re.fullmatch(
        r"P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?",
        value.strip(),
    )
    if not match or not any(match.groups()):
        return None
    days, hours, minutes, seconds = (float(part or 0) for part in match.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def dash_manifest_timing(manifest_text: str) -> tuple[float | None, bool | None]:
    head = manifest_text[:4096]
    if "<MPD" not in head:
        return None, None
    is_live = bool(re.search(r'<MPD[^>]*\btype\s*=\s*"dynamic"', head, re.S))
    match = re.search(r'mediaPresentationDuration\s*=\s*"([^"]+)"', head)
    duration = parse_iso8601_duration(match.group(1)) if match else None
    return duration, is_live


def select_variant(variants: list[dict[str, Any]], target_quality: str | None) -> tuple[dict[str, Any], str]:
    if target_quality:
        for variant in variants:
            if str(variant.get("resolution")) == target_quality:
                return variant, "target"
    return variants[0], "highest"


def public_item(item: dict[str, Any]) -> dict[str, Any]:
    copy = dict(item)
    copy["headers"] = list(item.get("headers", []))
    copy["output"] = str(item.get("output") or "")
    copy["selected_url"] = str(item.get("selected_url") or "")
    copy["url"] = str(item.get("url") or "")
    return copy


def prepare_item(
    args: argparse.Namespace,
    emitter: EventEmitter,
    *,
    include_preflight: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]], bool, float | None, str | None]:
    if args.item_file:
        item = load_item_file(args.item_file)
    else:
        item = parse_source_to_item(args, emitter)

    segments: list[dict[str, Any]] = []
    use_local_fallback = False
    duration: float | None = None
    ffmpeg: str | None = None

    if include_preflight and not args.no_preflight:
        emitter.emit("phase", phase="preflight", status="started", item_id=item["id"])
        ffmpeg = core.find_ffmpeg(args.ffmpeg)
        ffprobe = core.find_ffprobe(ffmpeg)
        if item["link_type"] == "m3u8":
            with capture_core_logs(emitter, "preflight"):
                segments, use_local_fallback = core.inspect_hls_playlist(
                    str(item["selected_url"]),
                    list(item["headers"]),
                )
            item["segment_count"] = len(segments)
            item["use_local_fallback"] = use_local_fallback

        segment_duration = sum(float(segment.get("duration") or 0.0) for segment in segments) or None
        if use_local_fallback and segments:
            duration = segment_duration
        else:
            duration = core.probe_duration(ffprobe, str(item["selected_url"]), list(item["headers"]))
            # Visubly copy: no ffprobe bundled; fall back to the playlist length for progress.
            if not duration:
                duration = segment_duration

        item["estimated_duration"] = duration
        emitter.emit(
            "phase",
            phase="preflight",
            status="completed",
            item_id=item["id"],
            segment_count=item["segment_count"],
            use_local_fallback=use_local_fallback,
            estimated_duration=seconds_or_none(duration),
        )

    return item, segments, use_local_fallback, duration, ffmpeg


def run_ffmpeg_with_progress_events(
    command: list[str],
    duration: float | None,
    emitter: EventEmitter,
    *,
    phase: str,
    item_id: str,
) -> tuple[int, list[str]]:
    started = time.time()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=core.NO_WINDOW_FLAGS,
    )
    emitter.emit("phase", phase=phase, status="started", item_id=item_id, pid=process.pid)

    speed = ""
    last_emit = 0.0
    last_error_lines: list[str] = []

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue
        if "=" not in line:
            if len(last_error_lines) < 20:
                last_error_lines.append(line)
            continue
        key, value = line.split("=", 1)
        if key == "speed":
            speed = value
            continue
        if key != "out_time_ms":
            continue
        try:
            done_seconds = int(value) / 1_000_000
        except ValueError:
            continue
        elapsed = time.time() - started
        percent = None
        eta = None
        if duration:
            percent = min(100.0, (done_seconds / duration) * 100)
            eta = (elapsed / percent * (100 - percent)) if percent > 0 else None
        now = time.time()
        if now - last_emit >= 0.25:
            emitter.emit(
                "progress",
                phase=phase,
                item_id=item_id,
                percent=round(percent, 2) if percent is not None else None,
                elapsed=seconds_or_none(elapsed),
                eta=seconds_or_none(eta),
                speed=speed or None,
                done_seconds=seconds_or_none(done_seconds),
                duration=seconds_or_none(duration),
            )
            last_emit = now

    return_code = process.wait()
    elapsed = time.time() - started
    emitter.emit(
        "progress",
        phase=phase,
        item_id=item_id,
        percent=100.0 if return_code == 0 else None,
        elapsed=seconds_or_none(elapsed),
        eta=0.0 if return_code == 0 else None,
        speed=speed or None,
        duration=seconds_or_none(duration),
    )
    emitter.emit("phase", phase=phase, status="completed" if return_code == 0 else "failed", item_id=item_id)
    if return_code != 0 and last_error_lines:
        emitter.emit("ffmpeg_output", phase=phase, item_id=item_id, lines=last_error_lines[-8:])
    return return_code, last_error_lines


def run_ffmpeg_with_retry_events(
    command: list[str],
    duration: float | None,
    emitter: EventEmitter,
    *,
    phase: str,
    item_id: str,
) -> int:
    # Visubly copy: older ffmpeg builds (e.g. the bundled 4.x) reject several newer HLS options one at a time,
    # so keep stripping whichever option ffmpeg complains about until it runs or nothing is left to strip.
    current = list(command)
    removable = ["-extension_picky", "-allowed_segment_extensions"]
    while True:
        completed, errors = run_ffmpeg_with_progress_events(current, duration, emitter, phase=phase, item_id=item_id)
        if completed == 0:
            return completed

        error_text = "\n".join(errors).lower()
        option = next(
            (
                opt
                for opt in removable
                if opt in current
                and (
                    f"unrecognized option '{opt[1:]}'" in error_text
                    or f"option {opt[1:]} not found" in error_text
                    or f"unknown option '{opt[1:]}'" in error_text
                )
            ),
            None,
        )
        if option is None:
            return completed
        emitter.emit("warning", phase=phase, item_id=item_id, message=f"Retrying without {option}.")
        current = core.remove_option_pair(current, option)


def build_direct_ffmpeg_command(item: dict[str, Any], ffmpeg: str, output: Path) -> list[str]:
    headers = core.headers_for_ffmpeg(list(item["headers"]))
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-y" if item["overwrite"] else "-n",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
    ]
    if headers:
        command.extend(["-headers", headers])
    # Visubly copy: these are HLS-demuxer options; ffmpeg rejects them ("Option ... not found") for mp4/DASH inputs.
    if str(item.get("link_type") or "m3u8") == "m3u8":
        command.extend(
            [
                "-allowed_extensions",
                "ALL",
                "-allowed_segment_extensions",
                "ALL",
                "-extension_picky",
                "0",
            ]
        )
    command.extend(
        [
            "-i",
            str(item["selected_url"]),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            str(output),
        ]
    )
    return command


def run_local_segment_fallback_events(
    segments: list[dict[str, Any]],
    item: dict[str, Any],
    ffmpeg: str,
    duration: float | None,
    emitter: EventEmitter,
) -> int:
    if not segments:
        emitter.emit("error", phase="download_segments", item_id=item["id"], message="No media segments detected.")
        return 1

    output = Path(str(item["output"]))
    output.parent.mkdir(parents=True, exist_ok=True)
    workers = core.normalize_workers(int(item["workers"]))
    temp_root = output.parent / ".extracting_video_tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="hls_", dir=str(temp_root)))
    combined_ts = temp_dir / "combined.ts"

    emitter.emit(
        "phase",
        phase="download_segments",
        status="started",
        item_id=item["id"],
        total_segments=len(segments),
        workers=workers,
    )
    started = time.time()
    try:
        segment_paths = [temp_dir / f"segment_{index:06d}.ts" for index in range(len(segments))]
        header_lines = list(item["headers"])

        if fastdl.find_curl():
            # Visubly: one curl --parallel (connections reused) instead of a curl process per segment.
            jobs = [(str(segment["url"]), segment_paths[index], None) for index, segment in enumerate(segments)]
            fastdl.download_all(
                jobs, header_lines, workers, work_dir=temp_dir,
                fetch_one=strict_fetch(header_lines),
                on_progress=segment_progress(emitter, item, started),
            on_retry=retry_notice(emitter, item),
            )
            for path in segment_paths:
                data = path.read_bytes()
                unwrapped = core.strip_segment_wrapper(data)
                if unwrapped != data:
                    path.write_bytes(unwrapped)
        else:
            def download_segment(index: int, segment: dict[str, Any]) -> int:
                data = core.fetch_bytes_with_retry(
                    str(segment["url"]),
                    header_lines,
                    label=f"segment {index + 1}/{len(segments)}",
                )
                segment_paths[index].write_bytes(core.strip_segment_wrapper(data))
                return index

            completed_segments = 0
            report = segment_progress(emitter, item, started)
            with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as executor:
                future_map = {
                    executor.submit(download_segment, index, segment): index
                    for index, segment in enumerate(segments)
                }
                for future in concurrent.futures.as_completed(future_map):
                    try:
                        future.result()
                    except Exception as exc:
                        failed_index = future_map[future]
                        for pending in future_map:
                            pending.cancel()
                        raise RuntimeError(f"segment {failed_index + 1}/{len(segments)} failed: {exc}") from exc
                    completed_segments += 1
                    report(completed_segments, len(segments), 0.0)

        emitter.emit("phase", phase="combine_segments", status="started", item_id=item["id"])
        with combined_ts.open("wb") as combined:
            for path in segment_paths:
                combined.write(path.read_bytes())
        emitter.emit("phase", phase="combine_segments", status="completed", item_id=item["id"])

        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-y" if item["overwrite"] else "-n",
            "-i",
            str(combined_ts),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            str(output),
        ]
        return run_ffmpeg_with_retry_events(
            command,
            duration,
            emitter,
            phase="mux_ts_to_mp4",
            item_id=str(item["id"]),
        )
    except Exception as exc:
        emitter.emit("error", phase="download_segments", item_id=item["id"], message=str(exc))
        return 1
    finally:
        try:
            shutil.rmtree(temp_dir)
        except OSError as exc:
            emitter.emit("warning", phase="cleanup", item_id=item["id"], message=f"Temporary files kept at {temp_dir}: {exc}")
        # Visubly copy: drop the shared temp root too once no other download is using it (rmdir only removes empty dirs).
        with contextlib.suppress(OSError):
            temp_root.rmdir()


def strict_fetch(header_lines: list[str]):
    """Last-resort fetch for the parallel paths: urllib raises on HTTP 4xx/5xx (the curl call in
    core.fetch_bytes has no --fail and would save an error page as if it were the segment)."""

    def fetch(url: str, rng: str | None) -> bytes:
        lines = list(header_lines) + ([f"Range: bytes={rng}"] if rng else [])
        last: Exception | None = None
        for attempt in range(3):
            try:
                return core.fetch_bytes_with_urllib(url, lines)
            except Exception as exc:  # reported below
                last = exc
                time.sleep(1.0 * (attempt + 1))
        raise RuntimeError(f"download failed: {last}")

    return fetch


def retry_notice(emitter: EventEmitter, item: dict[str, Any]):
    def notice(failed: int, total: int, connections: int) -> None:
        emitter.emit(
            "warning",
            phase="download_segments",
            item_id=item["id"],
            message=f"{failed}/{total} parts failed (server may limit connections); retrying with {connections} connection(s).",
        )

    return notice


def segment_progress(emitter: EventEmitter, item: dict[str, Any], started: float, *, by_bytes: bool = False):
    """Progress callback for parallel downloads: percent, ETA and the real speed (MB/s)."""
    state = {"last": 0.0, "rate": 0.0}

    def report(done: int, total: int, rate: float) -> None:
        now = time.time()
        if rate > 0:
            state["rate"] = rate if not state["rate"] else state["rate"] * 0.6 + rate * 0.4
        if now - state["last"] < 0.4 and done < total:
            return
        state["last"] = now
        elapsed = now - started
        percent = done / total * 100 if total else 0.0
        eta = elapsed / done * (total - done) if done else None
        emitter.emit(
            "progress",
            phase="download_segments",
            item_id=item["id"],
            percent=round(percent, 2),
            elapsed=seconds_or_none(elapsed),
            eta=seconds_or_none(eta),
            completed_segments=done,
            total_segments=total,
            # Until a rate is known: "x/y đoạn" for segments, nothing for byte ranges.
            speed=fastdl.human_speed(state["rate"]) or (None if by_bytes else f"{done}/{total} đoạn"),
        )

    return report


def run_local_playlist_events(item: dict[str, Any], ffmpeg: str, duration: float | None, emitter: EventEmitter) -> int:
    """HLS that ffmpeg would fetch one segment at a time (fMP4 init maps, AES-128, discontinuities):
    download everything in parallel, rewrite the playlist to local files, let ffmpeg remux from disk.
    Raises fastdl.FastPathUnsupported for live / DRM / master playlists (caller falls back)."""
    if not fastdl.find_curl():
        raise fastdl.FastPathUnsupported("curl.exe not found")
    output = Path(str(item["output"]))
    header_lines = list(item["headers"])
    playlist_url = str(item["selected_url"])
    text = core.fetch_text(playlist_url, header_lines)
    temp_root = output.parent / ".extracting_video_tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="hlsfast_", dir=str(temp_root)))
    try:
        local, jobs = fastdl.localize_playlist(playlist_url, text, temp_dir)
        workers = core.normalize_workers(int(item["workers"]))
        emitter.emit("phase", phase="download_segments", status="started", item_id=item["id"], total_segments=len(jobs), workers=workers)
        started = time.time()
        fastdl.download_all(
            jobs, header_lines, workers, work_dir=temp_dir,
            fetch_one=strict_fetch(header_lines),
            on_progress=segment_progress(emitter, item, started),
            on_retry=retry_notice(emitter, item),
        )
        emitter.emit("phase", phase="download_segments", status="completed", item_id=item["id"])
        command = [
            ffmpeg, "-hide_banner", "-loglevel", "error", "-progress", "pipe:1", "-nostats",
            "-y" if item["overwrite"] else "-n",
            "-allowed_extensions", "ALL", "-allowed_segment_extensions", "ALL", "-extension_picky", "0",
            "-protocol_whitelist", "file,crypto",
            "-i", str(local), "-c", "copy", "-bsf:a", "aac_adtstoasc", str(output),
        ]
        return run_ffmpeg_with_retry_events(command, duration, emitter, phase="mux_ts_to_mp4", item_id=str(item["id"]))
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        with contextlib.suppress(OSError):
            temp_root.rmdir()


MIN_PARALLEL_FILE = 16 * 1024 * 1024


def run_direct_parallel_events(item: dict[str, Any], emitter: EventEmitter) -> int:
    """Direct file (MP4) with HTTP Range support: several connections at once, no remux.
    Raises fastdl.FastPathUnsupported when the server has no ranges or the file is small."""
    if not fastdl.find_curl():
        raise fastdl.FastPathUnsupported("curl.exe not found")
    output = Path(str(item["output"]))
    if output.exists() and not item["overwrite"]:
        raise fastdl.FastPathUnsupported("output exists")
    header_lines = list(item["headers"])
    url = str(item["selected_url"])
    size, ranges = fastdl.probe_ranges(url, header_lines)
    if not ranges or size < MIN_PARALLEL_FILE:
        raise fastdl.FastPathUnsupported("no range support" if not ranges else "small file")
    temp_root = output.parent / ".extracting_video_tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="mp4fast_", dir=str(temp_root)))
    try:
        parts = min(16, max(2, core.normalize_workers(int(item["workers"]))))
        emitter.emit("phase", phase="download_segments", status="started", item_id=item["id"], total_segments=parts, workers=parts)
        started = time.time()
        report = segment_progress(emitter, item, started, by_bytes=True)
        total_bytes = size

        def by_bytes(done: int, total: int, rate: float) -> None:
            got = 0
            for path in temp_dir.glob("part*.bin"):
                with contextlib.suppress(OSError):
                    got += path.stat().st_size
            report(min(got, total_bytes), total_bytes, rate)

        fastdl.download_ranges(url, header_lines, size, output, parts, work_dir=temp_dir, on_progress=by_bytes,
                               fetch_one=strict_fetch(header_lines), on_retry=retry_notice(emitter, item))
        emitter.emit("progress", phase="mux_ts_to_mp4", item_id=item["id"], percent=100.0, elapsed=seconds_or_none(time.time() - started), eta=0.0)
        return 0
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)
        with contextlib.suppress(OSError):
            temp_root.rmdir()


def run_download(args: argparse.Namespace, emitter: EventEmitter) -> int:
    item, segments, use_local_fallback, duration, ffmpeg = prepare_item(args, emitter, include_preflight=True)
    output = Path(str(item["output"]))
    output.parent.mkdir(parents=True, exist_ok=True)
    if ffmpeg is None:
        ffmpeg = core.find_ffmpeg(args.ffmpeg)
    emitter.emit("prepared", item=public_item(item))

    result = None
    existed_before = output.exists()
    if use_local_fallback:
        result = run_local_segment_fallback_events(segments, item, ffmpeg, duration, emitter)
    elif not getattr(args, "no_fast", False) and str(item.get("link_type") or "") in ("m3u8", "mp4"):
        # Visubly: parallel paths first; anything they can't handle goes to ffmpeg as before.
        try:
            if item["link_type"] == "m3u8":
                result = run_local_playlist_events(item, ffmpeg, duration, emitter)
            else:
                result = run_direct_parallel_events(item, emitter)
            if result != 0:
                emitter.emit("warning", phase="download_segments", item_id=item["id"], message="Parallel download failed; retrying with ffmpeg.")
                result = None
        except fastdl.FastPathUnsupported as exc:
            emitter.emit("log", phase="preflight", item_id=item["id"], message=f"Parallel download not used: {exc}.")
        except Exception as exc:  # network trouble etc.: the old path still gets its chance
            emitter.emit("warning", phase="download_segments", item_id=item["id"], message=f"Parallel download failed ({exc}); retrying with ffmpeg.")
            result = None
        if result is None and output.exists() and not existed_before:
            with contextlib.suppress(OSError):
                output.unlink()

    if result is None:
        command = build_direct_ffmpeg_command(item, ffmpeg, output)
        result = run_ffmpeg_with_retry_events(
            command,
            duration,
            emitter,
            phase="ffmpeg_download",
            item_id=str(item["id"]),
        )

    if result == 0:
        emitter.emit("done", item_id=item["id"], output=str(output.resolve()))
    else:
        emitter.emit("failed", item_id=item["id"], output=str(output), exit_code=result)
    return result


def run_prepare(args: argparse.Namespace, emitter: EventEmitter) -> int:
    item, _, _, _, _ = prepare_item(args, emitter, include_preflight=True)
    emitter.emit("prepared", item=public_item(item))
    return 0


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("source", nargs="*", help="Video URL or curl command. Use --source-file/--source-stdin for multiline curl.")
    parser.add_argument("--source-file", help="Read URL or curl command from a text file.")
    parser.add_argument("--source-stdin", action="store_true", help="Read URL or curl command from stdin.")
    parser.add_argument("--item-file", help="Read a prepared item JSON object from a file.")
    parser.add_argument("--item-id", help="Stable item id for UI queue tracking.")
    parser.add_argument("-t", "--type", choices=["m3u8", "mp4", "dash", "other"], default="m3u8", help="Input link type.")
    parser.add_argument("-n", "--name", help="Output video name without .mp4. Saved to VISUBLY_DOWNLOAD_DIR or ~/Videos/ViSUBLY by default.")
    parser.add_argument("-o", "--output", help="Full output MP4 path. Overrides --name.")
    parser.add_argument("--referer", help="Referer header.")
    parser.add_argument("--user-agent", default=core.DEFAULT_USER_AGENT, help="User-Agent header. Use '' to omit.")
    parser.add_argument("--header", action="append", default=[], help="Extra header, e.g. --header 'Origin: https://site.com'")
    parser.add_argument("--selected-url", help="Preselected HLS media playlist URL.")
    parser.add_argument("--selected-quality", help="Label for the preselected HLS quality.")
    parser.add_argument("--target-quality", default=DEFAULT_TARGET_QUALITY, help=f"Preferred HLS quality. Default: {DEFAULT_TARGET_QUALITY}.")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg.exe if it is not in PATH.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite output file if it exists.")
    parser.add_argument("--workers", type=int, default=core.DEFAULT_WORKERS, help=f"Parallel segment workers. Default: {core.DEFAULT_WORKERS}.")
    parser.add_argument("--no-preflight", action="store_true", help="Skip playlist inspection and duration probing.")
    parser.add_argument("--no-fast", action="store_true", help="Do not use the parallel download paths (ffmpeg only).")
    parser.add_argument("--event-log-file", help="Append JSON events to this file in addition to stdout.")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="JSON-lines runner for hls2mp4 UI integrations.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare_parser = subparsers.add_parser("prepare", help="Parse input and emit a prepared item JSON event.")
    add_common_args(prepare_parser)

    download_parser = subparsers.add_parser("download", help="Download one item and emit JSON progress events.")
    add_common_args(download_parser)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    emitter = EventEmitter(args.event_log_file)
    try:
        if args.command == "prepare":
            return run_prepare(args, emitter)
        if args.command == "download":
            return run_download(args, emitter)
        parser.error(f"Unknown command: {args.command}")
        return 2
    except SystemExit as exc:
        code = int(exc.code) if isinstance(exc.code, int) else 1
        emitter.emit("error", message=str(exc), exit_code=code)
        return code
    except Exception as exc:
        emitter.emit("error", message=str(exc), exit_code=1)
        return 1
    finally:
        emitter.close()


if __name__ == "__main__":
    raise SystemExit(main())
