#!/usr/bin/env python3
"""Bounded, read-only OOXML text extractor. Input ZIP bytes arrive on stdin."""

import io
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_ENTRIES = 2048
MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024
MAX_ENTRY_UNCOMPRESSED = 16 * 1024 * 1024
MAX_SHEETS = 64
MAX_SLIDES = 300
MAX_ROWS = 10000
MAX_COLUMNS = 256
UNSAFE_PART = re.compile(
    r"(^|/)(?:vbaproject\.bin|encryptedpackage|encryptioninfo|"
    r"activex|embeddings|externallinks|customui|oleobjects)(?:/|$)",
    re.IGNORECASE,
)


def local_name(tag):
    return tag.rsplit("}", 1)[-1]


def parse_xml(data):
    if b"<!DOCTYPE" in data.upper() or b"<!ENTITY" in data.upper():
        raise ValueError("unsafe_xml")
    return ET.fromstring(data)


def natural_key(name):
    return [int(value) if value.isdigit() else value for value in re.split(r"(\d+)", name)]


def validate_archive(archive, extension):
    infos = archive.infolist()
    if not infos or len(infos) > MAX_ENTRIES:
        raise ValueError("entry_count")
    names = set()
    total = 0
    for info in infos:
        name = info.filename.replace("\\", "/")
        if (
            not name
            or name.startswith("/")
            or "\x00" in name
            or any(part in ("", ".", "..") for part in name.rstrip("/").split("/"))
            or name in names
            or info.flag_bits & 0x1
            or info.file_size > MAX_ENTRY_UNCOMPRESSED
            or UNSAFE_PART.search(name)
        ):
            raise ValueError("unsafe_entry")
        names.add(name)
        total += info.file_size
        if total > MAX_TOTAL_UNCOMPRESSED:
            raise ValueError("archive_too_large")
        if info.file_size > 1024 * 1024 and info.compress_size * 200 < info.file_size:
            raise ValueError("compression_ratio")
        if name.endswith(".rels"):
            relation = archive.read(info)
            if b'TargetMode="External"' in relation or b"TargetMode='External'" in relation:
                raise ValueError("external_relationship")
    required = {
        "docx": "word/document.xml",
        "pptx": "ppt/presentation.xml",
        "xlsx": "xl/workbook.xml",
    }[extension]
    if "[Content_Types].xml" not in names or required not in names:
        raise ValueError("missing_part")
    content_types = archive.read("[Content_Types].xml").lower()
    expected = {
        "docx": b"wordprocessingml.document.main+xml",
        "pptx": b"presentationml.presentation.main+xml",
        "xlsx": b"spreadsheetml.sheet.main+xml",
    }[extension]
    if expected not in content_types or b"macroenabled" in content_types:
        raise ValueError("content_type")
    return names


def extraction_limitations(names, extension):
    checks = {
        "docx": (
            (r"word/media/", "embedded_media_not_extracted"),
            (r"word/charts?/", "charts_not_extracted"),
            (r"word/(?:comments|footnotes|endnotes)\.xml", "annotations_not_extracted"),
            (r"word/(?:header|footer)\d+\.xml", "headers_or_footers_not_extracted"),
        ),
        "pptx": (
            (r"ppt/media/", "embedded_media_not_extracted"),
            (r"ppt/charts?/", "charts_not_extracted"),
            (r"ppt/notesSlides/", "speaker_notes_not_extracted"),
            (r"ppt/comments?/", "annotations_not_extracted"),
        ),
        "xlsx": (
            (r"xl/media/", "embedded_media_not_extracted"),
            (r"xl/charts?/", "charts_not_extracted"),
            (r"xl/drawings?/", "drawings_not_extracted"),
            (r"xl/comments?/", "annotations_not_extracted"),
            (r"xl/pivotTables?/", "pivot_tables_not_extracted"),
        ),
    }[extension]
    limitations = []
    for pattern, code in checks:
        if any(re.match(pattern, name, re.IGNORECASE) for name in names):
            limitations.append(code)
    return sorted(set(limitations))


def docx_text(archive):
    root = parse_xml(archive.read("word/document.xml"))
    lines = []
    for paragraph in root.iter():
        if local_name(paragraph.tag) != "p":
            continue
        text = "".join(
            node.text or "" for node in paragraph.iter() if local_name(node.tag) == "t"
        ).strip()
        if text:
            lines.append(text)
    return "# Word 文档\n\n" + "\n\n".join(lines)


def pptx_text(archive, names):
    slides = sorted(
        (
            name
            for name in names
            if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
        ),
        key=natural_key,
    )
    if not slides or len(slides) > MAX_SLIDES:
        raise ValueError("slide_count")
    output = ["# PowerPoint 演示文稿"]
    for index, name in enumerate(slides, 1):
        root = parse_xml(archive.read(name))
        values = [
            (node.text or "").strip()
            for node in root.iter()
            if local_name(node.tag) == "t" and (node.text or "").strip()
        ]
        output.extend(["", f"## 第 {index} 页", "", "\n".join(values) or "[无文本]"])
    return "\n".join(output)


def shared_strings(archive, names):
    if "xl/sharedStrings.xml" not in names:
        return []
    root = parse_xml(archive.read("xl/sharedStrings.xml"))
    return [
        "".join(node.text or "" for node in item.iter() if local_name(node.tag) == "t")
        for item in root
        if local_name(item.tag) == "si"
    ]


def xlsx_text(archive, names):
    workbook = parse_xml(archive.read("xl/workbook.xml"))
    sheet_names = [
        node.attrib.get("name", f"Sheet {index}")
        for index, node in enumerate(
            (node for node in workbook.iter() if local_name(node.tag) == "sheet"), 1
        )
    ]
    sheets = sorted(
        (
            name
            for name in names
            if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", name)
        ),
        key=natural_key,
    )
    if not sheets or len(sheets) > MAX_SHEETS:
        raise ValueError("sheet_count")
    strings = shared_strings(archive, names)
    output = ["# Excel 工作簿"]
    for sheet_index, name in enumerate(sheets):
        root = parse_xml(archive.read(name))
        rows = [node for node in root.iter() if local_name(node.tag) == "row"]
        if len(rows) > MAX_ROWS:
            raise ValueError("row_count")
        output.extend(["", f"## 工作表：{sheet_names[sheet_index] if sheet_index < len(sheet_names) else sheet_index + 1}", ""])
        for row in rows:
            cells = [node for node in row if local_name(node.tag) == "c"]
            if len(cells) > MAX_COLUMNS:
                raise ValueError("column_count")
            values = []
            for cell in cells:
                kind = cell.attrib.get("t", "")
                value = next(
                    (node.text or "" for node in cell.iter() if local_name(node.tag) == "v"),
                    "",
                )
                if kind == "s" and value.isdigit():
                    index = int(value)
                    value = strings[index] if index < len(strings) else ""
                elif kind == "inlineStr":
                    value = "".join(
                        node.text or ""
                        for node in cell.iter()
                        if local_name(node.tag) == "t"
                    )
                formula = next(
                    (node.text or "" for node in cell.iter() if local_name(node.tag) == "f"),
                    "",
                )
                reference = cell.attrib.get("r", "")
                rendered = f"{reference}={value}"
                if formula:
                    rendered += f" [公式:{formula}]"
                values.append(rendered)
            if values:
                output.append(" | ".join(values))
    return "\n".join(output)


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in {"docx", "pptx", "xlsx"}:
        return 1
    extension = sys.argv[1]
    max_output = int(sys.argv[2])
    if max_output < 1 or max_output > 262144:
        return 1
    source = sys.stdin.buffer.read(20 * 1024 * 1024 + 1)
    if not source or len(source) > 20 * 1024 * 1024:
        return 1
    with zipfile.ZipFile(io.BytesIO(source), "r") as archive:
        names = validate_archive(archive, extension)
        limitations = extraction_limitations(names, extension)
        content = {
            "docx": lambda: docx_text(archive),
            "pptx": lambda: pptx_text(archive, names),
            "xlsx": lambda: xlsx_text(archive, names),
        }[extension]()
    encoded = content.encode("utf-8")
    if not content.strip() or len(encoded) > max_output:
        return 1
    sys.stdout.write(
        json.dumps(
            {
                "format": extension,
                "content": content,
                "extraction_integrity": "partial" if limitations else "complete",
                "extraction_limitations": limitations,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        raise SystemExit(1)
