#!/usr/bin/env python3
"""Shared generation and PNG helpers for canonical LogBrew brand assets."""

from __future__ import annotations

import shutil
import struct
import subprocess
import zlib
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
BRAND_ROOT = REPO_ROOT / "assets" / "brand"
MASTER_SVG = BRAND_ROOT / "logbrew-logo-espresso-bg-1600.svg"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

SVG_DERIVATIVES = {
    "assets/brand/logbrew-logo-espresso-bg-512.svg": ("espresso-bg", 512),
    "assets/brand/logbrew-logo-transparent-1600.svg": ("transparent", 1600),
    "assets/brand/logbrew-logo-transparent-512.svg": ("transparent", 512),
}

PNG_DERIVATIVES = {
    "assets/brand/app-icon-256.png": ("espresso-bg", 256),
    "assets/brand/app-store-icon-1024.png": ("espresso-bg", 1024),
    "assets/brand/google-play-icon-512.png": ("espresso-bg", 512),
    "assets/brand/logbrew-logo-espresso-bg-128.png": ("espresso-bg", 128),
    "assets/brand/logbrew-logo-espresso-bg-1600.png": ("espresso-bg", 1600),
    "assets/brand/logbrew-logo-espresso-bg-512.png": ("espresso-bg", 512),
    "assets/brand/logbrew-logo-transparent-128.png": ("transparent", 128),
    "assets/brand/logbrew-logo-transparent-1600.png": ("transparent", 1600),
    "assets/brand/logbrew-logo-transparent-512.png": ("transparent", 512),
}


def derive_svg(presentation: str, size: int) -> bytes:
    text = MASTER_SVG.read_text(encoding="utf-8")
    if presentation == "transparent":
        text = text.replace(
            "logbrew-logo-espresso-bg",
            "logbrew-logo-transparent",
            1,
        )
        background = '  <rect width="1600" height="1600" fill="#3C2B24"/>\n'
        if text.count(background) != 1:
            raise ValueError("canonical SVG espresso background contract drifted")
        text = text.replace(background, "", 1)
    elif presentation != "espresso-bg":
        raise ValueError(f"unsupported brand presentation: {presentation}")

    if size != 1600:
        root_size = 'width="1600" height="1600" viewBox="0 0 1600 1600"'
        if text.count(root_size) != 1:
            raise ValueError("canonical SVG root size contract drifted")
        text = text.replace(
            root_size,
            f'width="{size}" height="{size}" viewBox="0 0 1600 1600"',
            1,
        )
        title_size = f"{presentation} 1600 optical-centered"
        if text.count(title_size) != 1:
            raise ValueError("canonical SVG title size contract drifted")
        text = text.replace(
            title_size,
            f"{presentation} {size} optical-centered",
            1,
        )
    return text.encode("utf-8")


def render_png(svg: bytes, size: int) -> bytes:
    executable = shutil.which("rsvg-convert")
    if executable is None:
        raise RuntimeError(
            "rsvg-convert is required; install librsvg2-bin or librsvg"
        )
    result = subprocess.run(
        [executable, "--format=png", "--width", str(size), "--height", str(size)],
        input=svg,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"rsvg-convert failed: {detail}")
    return result.stdout


def _paeth(left: int, up: int, upper_left: int) -> int:
    estimate = left + up - upper_left
    left_distance = abs(estimate - left)
    up_distance = abs(estimate - up)
    upper_left_distance = abs(estimate - upper_left)
    if left_distance <= up_distance and left_distance <= upper_left_distance:
        return left
    if up_distance <= upper_left_distance:
        return up
    return upper_left


def _reconstruct_row(
    encoded: bytes,
    previous: bytes,
    bytes_per_pixel: int,
    filter_type: int,
) -> bytes:
    row = bytearray(len(encoded))
    for index, value in enumerate(encoded):
        left = row[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
        up = previous[index]
        upper_left = previous[index - bytes_per_pixel] if index >= bytes_per_pixel else 0
        if filter_type == 0:
            predictor = 0
        elif filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        elif filter_type == 4:
            predictor = _paeth(left, up, upper_left)
        else:
            raise ValueError(f"unsupported PNG filter: {filter_type}")
        row[index] = (value + predictor) & 0xFF
    return bytes(row)


def _png_chunks(data: bytes) -> tuple[bytes, bytes]:
    if data[:8] != PNG_SIGNATURE:
        raise ValueError("invalid PNG signature")
    header = b""
    compressed = bytearray()
    offset = 8
    while offset < len(data):
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        kind = data[offset + 4 : offset + 8]
        payload_start = offset + 8
        payload_end = payload_start + length
        payload = data[payload_start:payload_end]
        expected_crc = struct.unpack(">I", data[payload_end : payload_end + 4])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            raise ValueError("PNG chunk checksum mismatch")
        if kind == b"IHDR":
            header = payload
        elif kind == b"IDAT":
            compressed.extend(payload)
        elif kind == b"IEND":
            break
        offset = payload_end + 4
    if len(header) != 13 or not compressed:
        raise ValueError("PNG is missing its header or image payload")
    return header, bytes(compressed)


def png_metadata(data: bytes) -> tuple[int, int, int, int, int, int, int]:
    """Return validated PNG header fields without reconstructing pixels."""
    header, _compressed = _png_chunks(data)
    return struct.unpack(">IIBBBBB", header)


def normalized_png_pixels(data: bytes) -> tuple[int, int, int, bytes]:
    """Return width, height, source color type, and normalized RGBA pixels."""

    header, compressed = _png_chunks(data)
    width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
        ">IIBBBBB", header
    )
    if (bit_depth, compression, filtering, interlace) != (8, 0, 0, 0):
        raise ValueError("brand PNGs must be non-interlaced 8-bit images")
    if color_type not in {2, 6}:
        raise ValueError(f"unsupported brand PNG color type: {color_type}")

    bytes_per_pixel = 3 if color_type == 2 else 4
    row_length = width * bytes_per_pixel
    decoded = zlib.decompress(compressed)
    expected_length = height * (row_length + 1)
    if len(decoded) != expected_length:
        raise ValueError("brand PNG scanline length is inconsistent")

    previous = bytes(row_length)
    rgba = bytearray()
    offset = 0
    for _ in range(height):
        filter_type = decoded[offset]
        encoded = decoded[offset + 1 : offset + 1 + row_length]
        row = _reconstruct_row(encoded, previous, bytes_per_pixel, filter_type)
        if color_type == 6:
            rgba.extend(row)
        else:
            for pixel in range(0, len(row), 3):
                rgba.extend(row[pixel : pixel + 3])
                rgba.append(255)
        previous = row
        offset += row_length + 1
    return width, height, color_type, bytes(rgba)
