const IMAGE_MARKER = /^!\[Image\]\((img_[A-Za-z0-9_-]+)\)$/;
const FILE_MARKER = /^<file\b[^<>]*\/>$/;
const FILE_KEY = /\bkey="([^"]*)"/g;

export function parseInvoiceResource(event) {
  const content = typeof event?.content === "string" ? event.content.trim() : event?.content;
  if (event?.messageType === "image") {
    const match = IMAGE_MARKER.exec(content);
    if (!match) throw coded("invalid_resource_marker");
    return {fileKey: match[1], type: "image"};
  }

  if (event?.messageType === "file") {
    if (typeof content !== "string" || !FILE_MARKER.test(content)) throw coded("invalid_resource_marker");
    const keys = [...content.matchAll(FILE_KEY)].map(match => match[1]);
    if (keys.length !== 1 || !/^file_[A-Za-z0-9_-]+$/.test(keys[0])) throw coded("invalid_resource_marker");
    return {fileKey: keys[0], type: "file"};
  }

  throw coded("unsupported_resource_type");
}

function coded(code) {
  return Object.assign(new Error(code), {code});
}
