#!/usr/bin/env python3
"""JSON-lines runner for app/UI integrations around hls2mp4."""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
import datetime as _dt
import io
import json
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

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
    quality_status = "provided" if args.selected_url else "not_checked"

    if args.type == "m3u8" and not args.selected_url:
        try:
            with capture_core_logs(emitter, "quality"):
                variants = [dict(item) for item in core.get_hls_variants(url, header_lines)]
        except Exception as exc:
            emitter.emit("warning", phase="quality", message=f"Could not check HLS variants: {exc}")
            variants = []

        if variants:
            selected, quality_status = select_variant(variants, args.target_quality)
            selected_url = str(selected["url"])
            selected_quality = str(selected.get("resolution") or "")
        else:
            quality_status = "no_variants"

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
    }


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

        def download_segment(index: int, segment: dict[str, Any]) -> int:
            data = core.fetch_bytes_with_retry(
                str(segment["url"]),
                list(item["headers"]),
                label=f"segment {index + 1}/{len(segments)}",
            )
            segment_paths[index].write_bytes(core.strip_segment_wrapper(data))
            return index

        completed_segments = 0
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
                elapsed = time.time() - started
                percent = completed_segments / len(segments) * 100
                eta = elapsed / completed_segments * (len(segments) - completed_segments)
                emitter.emit(
                    "progress",
                    phase="download_segments",
                    item_id=item["id"],
                    percent=round(percent, 2),
                    elapsed=seconds_or_none(elapsed),
                    eta=seconds_or_none(eta),
                    completed_segments=completed_segments,
                    total_segments=len(segments),
                    speed=f"{completed_segments}/{len(segments)} segments",
                )

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


def run_download(args: argparse.Namespace, emitter: EventEmitter) -> int:
    item, segments, use_local_fallback, duration, ffmpeg = prepare_item(args, emitter, include_preflight=True)
    output = Path(str(item["output"]))
    output.parent.mkdir(parents=True, exist_ok=True)
    if ffmpeg is None:
        ffmpeg = core.find_ffmpeg(args.ffmpeg)
    emitter.emit("prepared", item=public_item(item))

    if use_local_fallback:
        result = run_local_segment_fallback_events(segments, item, ffmpeg, duration, emitter)
    else:
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
