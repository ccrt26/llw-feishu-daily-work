import {open,lstat} from "node:fs/promises";
import {basename} from "node:path";

const EXECUTABLE_SUFFIXES = new Set(["exe","com","bat","cmd","sh","js","mjs","app","dmg","pkg"]);

export async function inspectInvoiceFile(file,{maxBytes=20 * 1024 * 1024}={}) {
  const info = await lstat(file);
  const extension = suffix(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maxBytes || unsafeDoubleSuffix(file,extension)) {
    return unsupported(extension,info.size);
  }

  const handle = await open(file,"r");
  const header = Buffer.alloc(16);
  try { await handle.read(header,0,header.length,0); }
  finally { await handle.close(); }

  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff && ["jpg","jpeg"].includes(extension)) {
    return {kind:"supported_image",format:"jpeg",extension,sizeBytes:info.size};
  }
  if (header.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])) && extension === "png") {
    return {kind:"supported_image",format:"png",extension,sizeBytes:info.size};
  }
  if (header.subarray(0,4).toString("ascii") === "RIFF" && header.subarray(8,12).toString("ascii") === "WEBP" && extension === "webp") {
    return {kind:"supported_image",format:"webp",extension,sizeBytes:info.size};
  }
  if (header.subarray(0,5).toString("ascii") === "%PDF-" && extension === "pdf") {
    return {kind:"pdf",format:"pdf",extension,sizeBytes:info.size};
  }
  if (header.subarray(0,4).equals(Buffer.from([0x50,0x4b,0x03,0x04])) && extension === "ofd") {
    return {kind:"ofd",format:"ofd",extension,sizeBytes:info.size};
  }
  return unsupported(extension,info.size);
}

function suffix(file) {
  const name = basename(file);
  const index = name.lastIndexOf(".");
  if (index <= 0) return "";
  const value = name.slice(index+1).toLowerCase();
  return /^[a-z]+$/.test(value) ? value : "";
}

function unsafeDoubleSuffix(file,extension) {
  if (!extension) return false;
  const parts = basename(file).toLowerCase().split(".");
  return parts.slice(1,-1).some(part => EXECUTABLE_SUFFIXES.has(part));
}

function unsupported(extension,sizeBytes) {
  return {kind:"unsupported",format:"unknown",extension,sizeBytes};
}
