#!/usr/bin/env python3
"""
Terminal helper for downloading video links to MP4 using ffmpeg.
"""

from __future__ import annotations

import os
import sys as _sys

# Visubly copy: only poke the console for ANSI colors when attached to a real terminal.
if os.name == "nt" and getattr(_sys.stdout, "isatty", lambda: False)():
    os.system("")  # Enable ANSI colors on Windows
class Colors:
    OK = "[92m"
    WARN = "[93m"
    ERR = "[91m"
    INFO = "[96m"
    RESET = "[0m"

def cprint(msg, color=Colors.INFO, **kwargs):
    print(f"{color}{msg}{Colors.RESET}", **kwargs)

import argparse
import concurrent.futures
import ctypes
import datetime as _dt
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
DEFAULT_WORKERS = 8
DEFAULT_SEGMENT_RETRIES = 5
URLLIB_TEXT_TIMEOUT = 20
URLLIB_SEGMENT_TIMEOUT = 20
CURL_CONNECT_TIMEOUT = 10
CURL_TEXT_MAX_TIME = 30
CURL_SEGMENT_MAX_TIME = 35
CURL_SEGMENT_SPEED_LIMIT = 1024
CURL_SEGMENT_SPEED_TIME = 15
# Visubly copy: the desktop app always passes -o; this is only a safety net.
DEFAULT_OUTPUT_DIR = Path(os.environ.get("VISUBLY_DOWNLOAD_DIR") or (Path.home() / "Videos" / "ViSUBLY"))
# Hide console windows for helper processes (curl/ffmpeg/ffprobe) on Windows.
NO_WINDOW_FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0

LINK_TYPES = {
    "1": ("m3u8", "HLS playlist (.m3u8)"),
    "2": ("mp4", "Direct MP4 file (.mp4)"),
    "3": ("dash", "MPEG-DASH manifest (.mpd)"),
    "4": ("other", "Other URL supported by ffmpeg"),
}


class TeeStream:
    def __init__(self, primary, secondary) -> None:
        self.primary = primary
        self.secondary = secondary
        self.encoding = getattr(primary, "encoding", "utf-8")

    def write(self, text: str) -> int:
        self.primary.write(text)
        self.primary.flush()
        self.secondary.write(text)
        self.secondary.flush()
        return len(text)

    def flush(self) -> None:
        self.primary.flush()
        self.secondary.flush()

    def isatty(self) -> bool:
        return bool(getattr(self.primary, "isatty", lambda: False)())


def set_console_title(title: str | None) -> None:
    if not title or os.name != "nt":
        return
    try:
        ctypes.windll.kernel32.SetConsoleTitleW(title)
    except Exception:
        pass


def setup_log_file(log_file: str | None):
    if not log_file:
        return None
    path = Path(log_file)
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a", encoding="utf-8", errors="replace")
    sys.stdout = TeeStream(sys.stdout, handle)
    sys.stderr = TeeStream(sys.stderr, handle)
    return handle


def safe_name(value: str) -> str:
    value = unicodedata.normalize("NFC", str(value or ""))
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", value).strip(" ._")
    value = re.sub(r"_+", "_", value)
    if value.upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}:
        value = f"{value}_video"
    return value[:80] or "video"


def output_path(url: str, video_name: str | None) -> Path:
    if video_name:
        stem = safe_name(Path(video_name).stem)
        return DEFAULT_OUTPUT_DIR / f"{stem}.mp4"

    stamp = _dt.datetime.now().strftime("%Y%m%d_%H%M%S")
    last = url.rstrip("/").split("/")[-1].split("?")[0]
    stem = safe_name(Path(last).stem)
    return DEFAULT_OUTPUT_DIR / f"{stem}_{stamp}.mp4"


def choose_link_type() -> tuple[str, str | None]:
    cprint("\nStep 1 - Choose link type", Colors.INFO)
    for key, (_, label) in LINK_TYPES.items():
        default = " [default]" if key == "1" else ""
        print(f"  {key}. {label}{default}")
    choice = input("Select type (press Enter for m3u8): ").strip()
    if not choice:
        choice = "1"
    if choice.lstrip().startswith(("curl", "http://", "https://")):
        print("Detected pasted link/curl at the type prompt; using m3u8.")
        return "m3u8", choice
    if choice in LINK_TYPES:
        selected, label = LINK_TYPES[choice]
        print(f"Selected: {label}")
        return selected, None
    lowered = choice.lower().lstrip(".")
    known = {value[0] for value in LINK_TYPES.values()}
    if lowered in known:
        print(f"Selected: {lowered}")
        return lowered, None
    print("Unknown type, using m3u8.")
    return "m3u8", None


def read_url_or_curl(link_type: str, initial_line: str | None = None) -> str:
    cprint("\nStep 2 - Paste link or full curl command", Colors.INFO)
    print(f"Paste {link_type} link or full curl command. End curl input with a blank line:")
    if initial_line is not None and not initial_line.lstrip().startswith("curl"):
        return initial_line.strip()
    lines: list[str] = [initial_line] if initial_line is not None else []
    while True:
        try:
            line = input()
        except EOFError:
            break
        if not line.strip() and lines:
            break
        if line.strip() or not lines:
            lines.append(line)
        if len(lines) == 1 and not lines[0].lstrip().startswith("curl"):
            break
    return "\n".join(lines).strip()


def read_video_name() -> str:
    cprint("\nStep 3 - Name output video", Colors.INFO)
    print("Enter video name without .mp4, or press Enter to use the default name.")
    return input("Video name: ").strip().strip('"')


def parse_curl(command_text: str) -> tuple[str, list[str]]:
    normalized = command_text.replace("\\\r\n", " ").replace("\\\n", " ")
    parts = shlex.split(normalized, posix=True)
    if not parts or Path(parts[0]).name.lower() not in {"curl", "curl.exe"}:
        raise SystemExit("Invalid curl command.")

    url = ""
    headers: list[str] = []
    i = 1
    while i < len(parts):
        part = parts[i]
        if part in {"-H", "--header"} and i + 1 < len(parts):
            header = parts[i + 1]
            if ":" in header:
                headers.append(header)
            elif header.endswith(";") and header[:-1].strip():
                # Chrome sometimes emits `-H 'Referer;'` to mean the header is
                # omitted/empty. ffmpeg and urllib expect `Name: value` lines.
                pass
            else:
                headers.append(header)
            i += 2
            continue
        if part.startswith("http://") or part.startswith("https://"):
            url = part
        i += 1

    if not url:
        raise SystemExit("Could not find URL in curl command.")
    return url, headers


def infer_link_type(url: str) -> str:
    lower_url = url.lower()
    parsed = urllib.parse.urlparse(lower_url)
    path = parsed.path
    if looks_like_hls_url(url):
        return "m3u8"
    if ".mpd" in lower_url:
        return "dash"
    if ".mp4" in lower_url:
        return "mp4"
    return "other"


def looks_like_hls_url(url: str) -> bool:
    lower_url = url.lower()
    parsed = urllib.parse.urlparse(lower_url)
    path = parsed.path
    filename = path.rsplit("/", 1)[-1]
    return (
        ".m3u8" in lower_url
        or path.endswith(".vl")
        or "/manifest" in path
        or filename in {"master.txt", "index.txt", "playlist.txt"}
        or (path.endswith(".txt") and "/hls" in path)
    )


def find_ffmpeg(custom_path: str | None) -> str:
    if custom_path:
        candidate = Path(custom_path)
        if candidate.exists():
            return str(candidate)
        raise SystemExit(f"ffmpeg not found at: {custom_path}")

    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    local = Path(__file__).with_name("ffmpeg.exe")
    if local.exists():
        return str(local)

    raise SystemExit(
        "ffmpeg is not installed or not in PATH.\n\n"
        "Run install_ffmpeg.bat in this folder, then reopen terminal.\n"
        "Manual install option:\n"
        "  winget install Gyan.FFmpeg"
    )


def find_ffprobe(ffmpeg: str) -> str | None:
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        return ffprobe
    sibling = Path(ffmpeg).with_name("ffprobe.exe")
    if sibling.exists():
        return str(sibling)
    return None


def build_header_lines(referer: str | None, user_agent: str | None, extra: list[str]) -> list[str]:
    lines: list[str] = []
    if referer:
        lines.append(f"Referer: {referer}")
    if user_agent:
        lines.append(f"User-Agent: {user_agent}")
    for header in extra:
        if ":" not in header:
            raise SystemExit(f"Invalid header, expected 'Name: value': {header}")
        lines.append(header)
    return lines


def headers_for_ffmpeg(lines: list[str]) -> str:
    return "\r\n".join(lines) + ("\r\n" if lines else "")


def headers_for_urllib(lines: list[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in lines:
        name, value = line.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def header_names(lines: list[str]) -> set[str]:
    names: set[str] = set()
    for line in lines:
        if ":" in line:
            names.add(line.split(":", 1)[0].strip().lower())
    return names


def header_value(lines: list[str], name: str) -> str | None:
    wanted = name.lower()
    for line in lines:
        if ":" not in line:
            continue
        left, right = line.split(":", 1)
        if left.strip().lower() == wanted:
            return right.strip()
    return None


def ensure_browser_like_headers(lines: list[str]) -> list[str]:
    enriched = list(lines)
    names = header_names(enriched)
    if "accept" not in names:
        enriched.append("Accept: */*")
    if "accept-language" not in names:
        enriched.append("Accept-Language: en-US,en;q=0.9")
    if "origin" not in names:
        referer = header_value(enriched, "referer")
        if referer:
            parsed = urllib.parse.urlparse(referer)
            if parsed.scheme and parsed.netloc:
                enriched.append(f"Origin: {parsed.scheme}://{parsed.netloc}")
    return enriched


def fetch_text_with_urllib(url: str, header_lines: list[str]) -> str:
    request = urllib.request.Request(url, headers=headers_for_urllib(header_lines))
    with urllib.request.urlopen(request, timeout=URLLIB_TEXT_TIMEOUT) as response:
        data = response.read()
    return data.decode("utf-8", errors="replace")


def fetch_text_with_curl(url: str, header_lines: list[str]) -> str:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl.exe not found")
    command = [
        curl,
        "-L",
        "--silent",
        "--show-error",
        "--connect-timeout",
        str(CURL_CONNECT_TIMEOUT),
        "--max-time",
        str(CURL_TEXT_MAX_TIME),
        url,
    ]
    for header in header_lines:
        command.extend(["-H", header])
    completed = subprocess.run(
        command, capture_output=True, text=True, timeout=CURL_TEXT_MAX_TIME + 5, creationflags=NO_WINDOW_FLAGS
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or f"curl failed with code {completed.returncode}")
    return completed.stdout


def fetch_text(url: str, header_lines: list[str]) -> str:
    try:
        return fetch_text_with_urllib(url, header_lines)
    except Exception as first_exc:
        try:
            return fetch_text_with_curl(url, header_lines)
        except Exception as second_exc:
            raise RuntimeError(f"urllib failed: {first_exc}; curl failed: {second_exc}") from second_exc


def fetch_bytes_with_urllib(url: str, header_lines: list[str]) -> bytes:
    request = urllib.request.Request(url, headers=headers_for_urllib(header_lines))
    with urllib.request.urlopen(request, timeout=URLLIB_SEGMENT_TIMEOUT) as response:
        return response.read()


def fetch_bytes_with_curl(url: str, header_lines: list[str]) -> bytes:
    curl = shutil.which("curl.exe") or shutil.which("curl")
    if not curl:
        raise RuntimeError("curl.exe not found")
    command = [
        curl,
        "-L",
        "--silent",
        "--show-error",
        "--connect-timeout",
        str(CURL_CONNECT_TIMEOUT),
        "--max-time",
        str(CURL_SEGMENT_MAX_TIME),
        "--speed-limit",
        str(CURL_SEGMENT_SPEED_LIMIT),
        "--speed-time",
        str(CURL_SEGMENT_SPEED_TIME),
        url,
    ]
    for header in header_lines:
        command.extend(["-H", header])
    completed = subprocess.run(command, capture_output=True, timeout=CURL_SEGMENT_MAX_TIME + 5, creationflags=NO_WINDOW_FLAGS)
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace")
        raise RuntimeError(stderr.strip() or f"curl failed with code {completed.returncode}")
    return completed.stdout


def fetch_bytes(url: str, header_lines: list[str]) -> bytes:
    try:
        return fetch_bytes_with_curl(url, header_lines)
    except Exception as first_exc:
        try:
            return fetch_bytes_with_urllib(url, header_lines)
        except Exception as second_exc:
            raise RuntimeError(f"curl failed: {first_exc}; urllib failed: {second_exc}") from second_exc


def fetch_bytes_with_retry(
    url: str,
    header_lines: list[str],
    *,
    attempts: int = DEFAULT_SEGMENT_RETRIES,
    label: str | None = None,
) -> bytes:
    attempts = max(1, attempts)
    last_exc: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return fetch_bytes(url, header_lines)
        except Exception as exc:
            last_exc = exc
            if attempt >= attempts:
                break
            time.sleep(min(8.0, 0.75 * (2 ** (attempt - 1))))
    name = label or url
    raise RuntimeError(f"{name} failed after {attempts} attempts: {last_exc}") from last_exc


def parse_stream_inf(value: str) -> dict[str, str]:
    attrs: dict[str, str] = {}
    for match in re.finditer(r'([A-Z0-9-]+)=("[^"]+"|[^,]+)', value):
        key = match.group(1)
        raw = match.group(2).strip()
        attrs[key] = raw[1:-1] if raw.startswith('"') and raw.endswith('"') else raw
    return attrs


def parse_hls_variants(master_url: str, playlist_text: str) -> list[dict[str, object]]:
    variants: list[dict[str, object]] = []
    lines = [line.strip() for line in playlist_text.splitlines() if line.strip()]
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("#EXT-X-STREAM-INF:") and i + 1 < len(lines):
            attrs = parse_stream_inf(line.split(":", 1)[1])
            uri = lines[i + 1]
            if not uri.startswith("#"):
                width = height = 0
                resolution = attrs.get("RESOLUTION", "")
                if "x" in resolution:
                    left, right = resolution.lower().split("x", 1)
                    width = int(left) if left.isdigit() else 0
                    height = int(right) if right.isdigit() else 0
                bandwidth_raw = attrs.get("AVERAGE-BANDWIDTH") or attrs.get("BANDWIDTH") or "0"
                bandwidth = int(bandwidth_raw) if bandwidth_raw.isdigit() else 0
                variants.append(
                    {
                        "url": urllib.parse.urljoin(master_url, uri),
                        "resolution": resolution or "unknown",
                        "height": height,
                        "width": width,
                        "bandwidth": bandwidth,
                        "codecs": attrs.get("CODECS", "unknown"),
                    }
                )
                i += 2
                continue
        i += 1
    variants.sort(key=lambda item: (int(item["height"]), int(item["bandwidth"])), reverse=True)
    return variants


def get_hls_variants(url: str, header_lines: list[str]) -> list[dict[str, object]]:
    playlist_text = fetch_text(url, header_lines)
    return parse_hls_variants(url, playlist_text)


def parse_hls_segments(playlist_url: str, playlist_text: str) -> list[dict[str, object]]:
    segments: list[dict[str, object]] = []
    pending_duration: float | None = None
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXTINF:"):
            value = line.split(":", 1)[1].split(",", 1)[0]
            try:
                pending_duration = float(value)
            except ValueError:
                pending_duration = None
            continue
        if pending_duration is not None and not line.startswith("#"):
            segments.append(
                {
                    "url": urllib.parse.urljoin(playlist_url, line),
                    "duration": pending_duration,
                }
            )
            pending_duration = None
    return segments


def find_png_end(data: bytes) -> int | None:
    marker = data.find(b"IEND")
    if marker < 0:
        return None
    return marker + 8


def find_ts_offset(data: bytes) -> int | None:
    png_end = find_png_end(data) or 0
    best_offset: int | None = None
    best_count = 0
    limit = min(len(data), max(png_end + 4096, 4096))
    for offset in range(png_end, limit):
        count = 0
        for index in range(20):
            pos = offset + index * 188
            if pos < len(data) and data[pos] == 0x47:
                count += 1
        if count > best_count:
            best_count = count
            best_offset = offset
        if count >= 10:
            return offset
    return best_offset if best_count >= 5 else None


def strip_segment_wrapper(data: bytes) -> bytes:
    if data.startswith(b"\x47"):
        return data
    offset = find_ts_offset(data)
    if offset is not None:
        return data[offset:]
    return data


def detect_ts_segment_kind(segment_url: str, header_lines: list[str]) -> str | None:
    try:
        data = fetch_bytes(segment_url, header_lines)
    except Exception as exc:
        print(f"Could not inspect first segment wrapper: {exc}")
        return None
    offset = find_ts_offset(data)
    if offset is None:
        return None
    if data.startswith(b"\x89PNG"):
        return "png-wrapped"
    if offset == 0 or data.startswith(b"\x47"):
        return "mpeg-ts"
    return "wrapped"


def inspect_hls_playlist(url: str, header_lines: list[str]) -> tuple[list[dict[str, object]], bool]:
    try:
        playlist_text = fetch_text(url, header_lines)
    except Exception as exc:
        print(f"Could not preflight selected playlist: {exc}")
        return [], False

    variants = parse_hls_variants(url, playlist_text)
    segments = parse_hls_segments(url, playlist_text)
    segment_count = len(segments)
    init_map_count = 0
    has_encryption = False
    has_byte_ranges = False
    has_discontinuity = False
    suspicious_urls: list[str] = []
    for raw_line in playlist_text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-KEY:") and "METHOD=NONE" not in line.upper():
            has_encryption = True
            continue
        if line.startswith("#EXT-X-BYTERANGE:"):
            has_byte_ranges = True
            continue
        if line.startswith("#EXT-X-DISCONTINUITY"):
            has_discontinuity = True
            continue
        if line.startswith("#EXT-X-MAP:"):
            init_map_count += 1
            match = re.search(r'URI="([^"]+)"', line)
            if match:
                mapped = urllib.parse.urljoin(url, match.group(1))
                if not Path(urllib.parse.urlparse(mapped).path).suffix:
                    suspicious_urls.append(mapped)
            continue

    if variants:
        print(f"Selected playlist preflight: nested master playlist with {len(variants)} variants.")
        return [], False
    if segment_count:
        print(f"Selected playlist preflight: media playlist, {segment_count} segments, {init_map_count} init maps.")
        for segment in segments[:5]:
            resolved = str(segment["url"])
            if not Path(urllib.parse.urlparse(resolved).path).suffix:
                suspicious_urls.append(resolved)
        if suspicious_urls:
            print("Note: some segment/init URLs have no file extension; ffmpeg extension checks are disabled.")
        ts_kind = detect_ts_segment_kind(str(segments[0]["url"]), header_lines)
        local_blockers = []
        if init_map_count:
            local_blockers.append("init maps")
        if has_encryption:
            local_blockers.append("encryption")
        if has_byte_ranges:
            local_blockers.append("byte ranges")
        if has_discontinuity:
            local_blockers.append("discontinuities")
        if ts_kind and not local_blockers:
            if ts_kind == "png-wrapped":
                print("Detected PNG-wrapped MPEG-TS segments; using local parallel unwrap fallback.")
            elif ts_kind == "mpeg-ts":
                print("Detected MPEG-TS segments; using local parallel segment downloader.")
            else:
                print("Detected wrapped MPEG-TS segments; using local parallel unwrap fallback.")
            return segments, True
        if ts_kind and local_blockers:
            print(f"Detected MPEG-TS segments, but using ffmpeg because playlist has {', '.join(local_blockers)}.")
        return segments, False
    print("Selected playlist preflight: no variants or media segments detected.")
    return [], False


def choose_hls_variant(url: str, header_lines: list[str], interactive: bool) -> tuple[str, str | None]:
    try:
        variants = get_hls_variants(url, header_lines)
    except Exception as exc:
        print(f"Could not check video quality list: {exc}")
        print("Continuing with the original URL.")
        return url, None

    if not variants:
        print("Could not check video quality list: this looks like a media playlist or unknown playlist format.")
        print("Continuing with the original URL.")
        return url, None

    print("\nDetected HLS quality variants:")
    for idx, item in enumerate(variants, start=1):
        mbps = int(item["bandwidth"]) / 1_000_000 if item["bandwidth"] else 0
        speed = f"{mbps:.2f} Mbps" if mbps else "unknown bitrate"
        print(f"  {idx}. {item['resolution']} - {speed}")

    if interactive:
        choice = input("Choose quality (press Enter for highest): ").strip()
        if choice.isdigit() and 1 <= int(choice) <= len(variants):
            selected = variants[int(choice) - 1]
        else:
            selected = variants[0]
    else:
        selected = variants[0]

    label = str(selected["resolution"])
    print(f"Selected quality: {label}")
    return str(selected["url"]), label


def probe_duration(ffprobe: str | None, url: str, header_lines: list[str]) -> float | None:
    if not ffprobe:
        return None
    command = [
        ffprobe,
        "-v",
        "error",
    ]
    headers = headers_for_ffmpeg(header_lines)
    if headers:
        command.extend(["-headers", headers])
    command.extend([
        "-show_entries",
        "format=duration",
        "-of",
        "default=nk=1:nw=1",
        "-allowed_extensions",
        "ALL",
        "-allowed_segment_extensions",
        "ALL",
        "-extension_picky",
        "0",
        url,
    ])
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=30, creationflags=NO_WINDOW_FLAGS)
    except Exception:
        return None
    if completed.returncode != 0:
        return None
    text = completed.stdout.strip().splitlines()
    if not text:
        return None
    try:
        duration = float(text[-1])
    except ValueError:
        return None
    return duration if duration > 0 else None


def format_time(seconds: float | None) -> str:
    if seconds is None:
        return "--:--"
    seconds = max(0, int(seconds))
    hours, remainder = divmod(seconds, 3600)
    minutes, sec = divmod(remainder, 60)
    if hours:
        return f"{hours:02d}:{minutes:02d}:{sec:02d}"
    return f"{minutes:02d}:{sec:02d}"


def format_bytes(value: int | float) -> str:
    size = float(max(0, value))
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
        size /= 1024
    return f"{size:.1f} TB"


def render_progress(percent: float | None, elapsed: float, eta: float | None, speed: str) -> None:
    width = 28
    if percent is None:
        bar = "." * width
        pct = " --.-%"
    else:
        filled = max(0, min(width, int(width * percent / 100)))
        bar = "#" * filled + "." * (width - filled)
        pct = f"{percent:5.1f}%"
    message = (
        f"\r[{bar}] {pct} | elapsed {format_time(elapsed)} | "
        f"eta {format_time(eta)} | speed {speed or 'unknown'}"
    )
    print(message, end="", flush=True)


def normalize_workers(value: int | None) -> int:
    if value is None:
        return DEFAULT_WORKERS
    if value < 1:
        print(f"Invalid workers value {value}; using default {DEFAULT_WORKERS}.")
        return DEFAULT_WORKERS
    return value


def remove_option_pair(command: list[str], option: str) -> list[str]:
    cleaned: list[str] = []
    skip_next = False
    for item in command:
        if skip_next:
            skip_next = False
            continue
        if item == option:
            skip_next = True
            continue
        cleaned.append(item)
    return cleaned


def run_ffmpeg_with_progress(command: list[str], duration: float | None) -> tuple[int, list[str]]:
    started = time.time()
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
    )
    speed = ""
    last_render = 0.0
    last_error_lines: list[str] = []

    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        if not line:
            continue
        if "=" not in line:
            if len(last_error_lines) < 8:
                last_error_lines.append(line)
            continue
        key, value = line.split("=", 1)
        if key == "speed":
            speed = value
        elif key == "out_time_ms":
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
            if now - last_render >= 0.25:
                render_progress(percent, elapsed, eta, speed)
                last_render = now

    return_code = process.wait()
    elapsed = time.time() - started
    render_progress(100.0 if return_code == 0 else None, elapsed, 0.0 if return_code == 0 else None, speed)
    print()
    if return_code != 0 and last_error_lines:
        print("\nffmpeg output:")
        for line in last_error_lines[-8:]:
            print(f"  {line}")
        print("\nffmpeg command:")
        print("  " + subprocess.list2cmdline(command))
    return return_code, last_error_lines


def run_ffmpeg_with_retry(command: list[str], duration: float | None) -> int:
    completed, errors = run_ffmpeg_with_progress(command, duration)
    if completed == 0:
        return completed

    error_text = "\n".join(errors).lower()
    if "-extension_picky" in command and (
        "unrecognized option 'extension_picky'" in error_text
        or "option extension_picky not found" in error_text
        or "unknown option 'extension_picky'" in error_text
    ):
        print("\nRetrying without -extension_picky because this ffmpeg build does not support it...")
        retry_command = remove_option_pair(command, "-extension_picky")
        completed, _ = run_ffmpeg_with_progress(retry_command, duration)
        return completed

    if "-allowed_segment_extensions" in command and (
        "unrecognized option 'allowed_segment_extensions'" in error_text
        or "option allowed_segment_extensions not found" in error_text
        or "unknown option 'allowed_segment_extensions'" in error_text
    ):
        print("\nRetrying without -allowed_segment_extensions because this ffmpeg build does not support it...")
        retry_command = remove_option_pair(command, "-allowed_segment_extensions")
        completed, _ = run_ffmpeg_with_progress(retry_command, duration)
        return completed

    return completed


def run_local_segment_fallback(
    segments: list[dict[str, object]],
    header_lines: list[str],
    output: Path,
    ffmpeg: str,
    overwrite: bool,
    workers: int = DEFAULT_WORKERS,
) -> int:
    if not segments:
        print("Local fallback cannot run because no media segments were detected.")
        return 1

    workers = normalize_workers(workers)
    total_duration = sum(float(segment.get("duration") or 0.0) for segment in segments)
    temp_root = output.parent / ".extracting_video_tmp"
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix="hls_", dir=str(temp_root)))
    combined_ts = temp_dir / "combined.ts"

    print(
        f"\nDownloading and unwrapping segments locally with {workers} workers "
        f"({DEFAULT_SEGMENT_RETRIES} retries per segment)..."
    )
    started = time.time()
    try:
        segment_paths = [temp_dir / f"segment_{index:06d}.ts" for index in range(len(segments))]

        def download_segment(index: int, segment: dict[str, object]) -> int:
            data = fetch_bytes_with_retry(
                str(segment["url"]),
                header_lines,
                label=f"segment {index + 1}/{len(segments)}",
            )
            segment_paths[index].write_bytes(strip_segment_wrapper(data))
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
                eta = (
                    elapsed / completed_segments * (len(segments) - completed_segments)
                    if completed_segments
                    else None
                )
                render_progress(
                    percent,
                    elapsed,
                    eta,
                    f"{completed_segments}/{len(segments)} segments",
                )
        print()

        with combined_ts.open("wb") as combined:
            for path in segment_paths:
                combined.write(path.read_bytes())

        combined_size = combined_ts.stat().st_size
        free_bytes = shutil.disk_usage(output.parent).free
        if free_bytes < combined_size:
            print(
                f"Warning: {output.parent} has {format_bytes(free_bytes)} free; "
                f"muxing may need about {format_bytes(combined_size)} more."
            )

        command = [
            ffmpeg,
            "-hide_banner",
            "-loglevel",
            "error",
            "-progress",
            "pipe:1",
            "-nostats",
            "-y" if overwrite else "-n",
            "-i",
            str(combined_ts),
            "-c",
            "copy",
            "-bsf:a",
            "aac_adtstoasc",
            str(output),
        ]
        print("\nMuxing local TS to MP4...")
        completed = run_ffmpeg_with_retry(command, total_duration or None)
        return completed
    finally:
        try:
            shutil.rmtree(temp_dir)
        except OSError:
            print(f"Temporary files kept at: {temp_dir}")


def download_video(
    *,
    url: str,
    header_lines: list[str],
    link_type: str,
    output: Path,
    ffmpeg_path: str | None = None,
    overwrite: bool = False,
    interactive_quality: bool = True,
    selected_url: str | None = None,
    selected_quality: str | None = None,
    workers: int = DEFAULT_WORKERS,
) -> int:
    output.parent.mkdir(parents=True, exist_ok=True)

    ffmpeg = find_ffmpeg(ffmpeg_path)
    ffprobe = find_ffprobe(ffmpeg)

    media_segments: list[dict[str, object]] = []
    use_local_unwrap = False
    source_url = selected_url or url
    quality_label = selected_quality
    if link_type == "m3u8":
        if selected_url is None:
            source_url, quality_label = choose_hls_variant(url, header_lines, interactive_quality)
        media_segments, use_local_unwrap = inspect_hls_playlist(source_url, header_lines)

    print("\nPreparing download...")
    print(f"Input type: {link_type}")
    if quality_label:
        print(f"Quality: {quality_label}")
    print(f"Source URL: {source_url}")
    print(f"Output MP4: {output.resolve()}")

    if use_local_unwrap and media_segments:
        duration = sum(float(segment.get("duration") or 0.0) for segment in media_segments) or None
    else:
        duration = probe_duration(ffprobe, source_url, header_lines)
    if duration:
        print(f"Estimated duration: {format_time(duration)}")
    else:
        print("Estimated duration: unknown; progress will still show elapsed time.")

    if use_local_unwrap:
        completed = run_local_segment_fallback(
            media_segments,
            header_lines,
            output,
            ffmpeg,
            overwrite,
            workers,
        )
        if completed == 0:
            print(f"\nDone: {output.resolve()}")
        else:
            print("\nLocal segment fallback failed.")
        return completed

    headers = headers_for_ffmpeg(header_lines)
    command = [
        ffmpeg,
        "-hide_banner",
        "-loglevel",
        "error",
        "-progress",
        "pipe:1",
        "-nostats",
        "-y" if overwrite else "-n",
        "-protocol_whitelist",
        "file,http,https,tcp,tls,crypto",
    ]
    if headers:
        command.extend(["-headers", headers])
    command.extend([
        "-allowed_extensions",
        "ALL",
        "-allowed_segment_extensions",
        "ALL",
        "-extension_picky",
        "0",
        "-i",
        source_url,
        "-c",
        "copy",
        "-bsf:a",
        "aac_adtstoasc",
        str(output),
    ])

    print("\nDownloading...")
    completed = run_ffmpeg_with_retry(command, duration)
    if completed == 0:
        print(f"\nDone: {output.resolve()}")
    else:
        print("\nffmpeg failed. If the server blocks the request, retry with a full curl command from DevTools.")
    return completed


def run() -> int:
    parser = argparse.ArgumentParser(description="Download a video link and save it as MP4.")
    parser.add_argument("url", nargs="*", help="Video URL, or a full curl command.")
    parser.add_argument("-t", "--type", choices=["m3u8", "mp4", "dash", "other"], help="Input link type. Interactive default is m3u8.")
    parser.add_argument("-n", "--name", help="Output video name without .mp4. Saved to VISUBLY_DOWNLOAD_DIR or ~/Videos/ViSUBLY by default.")
    parser.add_argument("-o", "--output", help="Full output MP4 path. Overrides --name.")
    parser.add_argument("--referer", help="Referer header, often the page URL that contains the iframe/video.")
    parser.add_argument("--user-agent", default=DEFAULT_USER_AGENT, help="User-Agent header. Use '' to omit.")
    parser.add_argument("--header", action="append", default=[], help="Extra header, e.g. --header 'Origin: https://site.com'")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg.exe if it is not in PATH.")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite output file if it exists.")
    parser.add_argument("--selected-url", help="Preselected HLS media playlist URL. Used by list mode.")
    parser.add_argument("--selected-quality", help="Label for the preselected HLS quality. Used by list mode.")
    parser.add_argument("--log-file", help="Append console output to this log file.")
    parser.add_argument("--console-title", help="Set the console window title on Windows.")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS, help=f"Parallel segment workers for local HLS fallback. Default: {DEFAULT_WORKERS}.")
    args = parser.parse_args()

    original_stdout = sys.stdout
    original_stderr = sys.stderr
    log_handle = setup_log_file(args.log_file)
    try:
        set_console_title(args.console_title)
        interactive = not args.url
        initial_line = None
        if args.type:
            link_type = args.type
        elif interactive:
            link_type, initial_line = choose_link_type()
        else:
            link_type = None
        pasted = " ".join(args.url).strip() if args.url else read_url_or_curl(link_type, initial_line)
        if pasted.lstrip().startswith("curl"):
            url, curl_headers = parse_curl(pasted)
            args.header = curl_headers + args.header
            args.user_agent = ""
        else:
            url = pasted.strip().strip('"')

        if not url:
            raise SystemExit("No URL provided.")
        if url.startswith("blob:"):
            raise SystemExit("This is a blob URL. Extract the real m3u8/mp4 URL from DevTools Network first.")
        if link_type is None:
            link_type = infer_link_type(url)
        if link_type == "m3u8" and not looks_like_hls_url(url):
            print("Warning: selected type is m3u8, but URL does not look like .m3u8. ffmpeg will try it anyway.")
        if link_type == "mp4" and ".mp4" not in url.lower():
            print("Warning: selected type is mp4, but URL does not look like .mp4. ffmpeg will try it anyway.")

        video_name = args.name if args.name is not None else ("" if args.url else read_video_name())
        header_lines = ensure_browser_like_headers(build_header_lines(
            args.referer,
            args.user_agent if args.user_agent else None,
            args.header,
        ))
        output = Path(args.output) if args.output else output_path(url, video_name)
        return download_video(
            url=url,
            header_lines=header_lines,
            link_type=link_type,
            output=output,
            ffmpeg_path=args.ffmpeg,
            overwrite=args.overwrite,
            interactive_quality=interactive,
            selected_url=args.selected_url,
            selected_quality=args.selected_quality,
            workers=normalize_workers(args.workers),
        )
    finally:
        if log_handle:
            sys.stdout.flush()
            sys.stderr.flush()
            sys.stdout = original_stdout
            sys.stderr = original_stderr
            log_handle.close()


if __name__ == "__main__":
    raise SystemExit(run())
