#!/usr/bin/python3
import sys
sys.dont_write_bytecode = True

import argparse
import binascii
import json
import os
import struct
import zlib
from pathlib import Path

EXIT_ENCRYPTED = 20
EXIT_STRUCTURE = 21
EXIT_PAGE_LIMIT = 22
EXIT_TEXT = 23
EXIT_RENDER = 24


class ProcessorError(Exception):
    def __init__(self, exit_code):
        super().__init__()
        self.exit_code = exit_code


def parse_args():
    parser = argparse.ArgumentParser(add_help=False, exit_on_error=False)
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-pages", required=True, type=int)
    parser.add_argument("--max-text-bytes", required=True, type=int)
    parser.add_argument("--max-render-bytes", required=True, type=int)
    parser.add_argument("--max-dimension", required=True, type=int)
    try:
        args = parser.parse_args()
    except BaseException:
        raise ProcessorError(EXIT_STRUCTURE)
    if (
        args.max_pages != 10
        or args.max_text_bytes != 262_144
        or args.max_render_bytes != 100 * 1024 * 1024
        or args.max_dimension != 3508
    ):
        raise ProcessorError(EXIT_STRUCTURE)
    return args


def png_chunk(kind, data):
    return (
        struct.pack(">I", len(data))
        + kind
        + data
        + struct.pack(">I", binascii.crc32(kind + data) & 0xFFFFFFFF)
    )


def encode_rgbx_png(bitmap):
    if bitmap.mode != "RGBX" or bitmap.n_channels != 4:
        raise ProcessorError(EXIT_RENDER)
    raw = memoryview(bitmap.buffer)
    rows = bytearray()
    width, height, stride = bitmap.width, bitmap.height, bitmap.stride
    for row_index in range(height):
        start = row_index * stride
        row = raw[start : start + width * 4]
        rows.append(0)
        for offset in range(0, len(row), 4):
            rows.extend(row[offset : offset + 3])
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", header)
        + png_chunk(b"IDAT", zlib.compress(bytes(rows), level=6))
        + png_chunk(b"IEND", b"")
    )


def atomic_write(path, data):
    temporary = path.with_name(path.name + ".tmp")
    with open(temporary, "xb") as handle:
        handle.write(data)
        handle.flush()
        os.fsync(handle.fileno())
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def process_document(args):
    try:
        import pypdfium2 as pdfium
    except BaseException:
        raise ProcessorError(EXIT_STRUCTURE)

    source = Path(args.input)
    output = Path(args.output)
    try:
        source_info = os.lstat(source)
        output_info = os.lstat(output)
        if not source_info.st_mode or source.is_symlink() or not source.is_file():
            raise ProcessorError(EXIT_STRUCTURE)
        if not output_info.st_mode or output.is_symlink() or not output.is_dir() or any(output.iterdir()):
            raise ProcessorError(EXIT_STRUCTURE)
    except ProcessorError:
        raise
    except BaseException:
        raise ProcessorError(EXIT_STRUCTURE)

    try:
        document = pdfium.PdfDocument(str(source))
    except pdfium.PdfiumError as error:
        raise ProcessorError(EXIT_ENCRYPTED if getattr(error, "err_code", None) == 4 else EXIT_STRUCTURE)
    except BaseException:
        raise ProcessorError(EXIT_STRUCTURE)

    try:
        try:
            document.init_forms()
            page_count = len(document)
        except BaseException:
            raise ProcessorError(EXIT_STRUCTURE)
        if page_count < 1 or page_count > args.max_pages:
            raise ProcessorError(EXIT_PAGE_LIMIT)

        text_parts = []
        text_bytes = 0
        for page_index in range(page_count):
            page = None
            text_page = None
            try:
                page = document[page_index]
                text_page = page.get_textpage()
                page_text = text_page.get_text_range()
                if not isinstance(page_text, str):
                    raise ProcessorError(EXIT_TEXT)
                encoded = page_text.encode("utf-8")
                separator = b"" if page_index == 0 else b"\n\f\n"
                text_bytes += len(separator) + len(encoded)
                if text_bytes > args.max_text_bytes:
                    raise ProcessorError(EXIT_TEXT)
                if page_index:
                    text_parts.append("\n\f\n")
                text_parts.append(page_text)
            except ProcessorError:
                raise
            except BaseException:
                raise ProcessorError(EXIT_TEXT)
            finally:
                if text_page is not None:
                    text_page.close()
                if page is not None:
                    page.close()
        atomic_write(output / "extracted.txt", "".join(text_parts).encode("utf-8"))

        page_files = []
        render_bytes = 0
        for page_index in range(page_count):
            page = None
            bitmap = None
            try:
                page = document[page_index]
                width, height = page.get_size()
                if width <= 0 or height <= 0:
                    raise ProcessorError(EXIT_RENDER)
                scale = args.max_dimension / max(width, height)
                bitmap = page.render(
                    scale=scale,
                    may_draw_forms=True,
                    fill_color=(255, 255, 255, 255),
                    draw_annots=True,
                    rev_byteorder=True,
                    prefer_bgrx=True,
                )
                encoded = encode_rgbx_png(bitmap)
                render_bytes += len(encoded)
                if render_bytes > args.max_render_bytes:
                    raise ProcessorError(EXIT_RENDER)
                name = f"page-{page_index + 1}.png"
                atomic_write(output / name, encoded)
                page_files.append(name)
            except ProcessorError:
                raise
            except BaseException:
                raise ProcessorError(EXIT_RENDER)
            finally:
                if bitmap is not None:
                    bitmap.close()
                if page is not None:
                    page.close()

        manifest = {
            "version": 1,
            "pageCount": page_count,
            "textFile": "extracted.txt",
            "pageFiles": page_files,
        }
        atomic_write(
            output / "manifest.json",
            json.dumps(manifest, separators=(",", ":"), ensure_ascii=True).encode("ascii"),
        )
    finally:
        document.close()


def self_check():
    try:
        import pypdfium2  # noqa: F401
        from pypdfium2.version import PYPDFIUM_INFO
        if PYPDFIUM_INFO.api_tag != (5, 11, 0):
            raise ProcessorError(EXIT_STRUCTURE)
    except ProcessorError:
        raise
    except BaseException:
        raise ProcessorError(EXIT_STRUCTURE)


def main():
    try:
        if sys.argv[1:] == ["--self-check"]:
            self_check()
            return 0
        process_document(parse_args())
        return 0
    except ProcessorError as error:
        return error.exit_code
    except BaseException:
        return EXIT_STRUCTURE


if __name__ == "__main__":
    raise SystemExit(main())
