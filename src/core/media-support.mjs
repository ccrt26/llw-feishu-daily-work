const UNSUPPORTED_MEDIA_EXTENSIONS=new Set([
  "aac","aif","aiff","avi","flac","m4a","m4v","mkv",
  "mov","mp3","mp4","ogg","opus","wav","webm"
]);

export function isUnsupportedMediaExtension(value) {
  if (typeof value!=="string") return false;
  return UNSUPPORTED_MEDIA_EXTENSIONS.has(
    value.trim().toLowerCase().replace(/^\./u,"")
  );
}
