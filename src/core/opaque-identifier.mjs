export function isPreparedSourceSetId(value) {
  return typeof value==="string"&&
    /^[A-Za-z0-9_-]{43}$/u.test(value);
}
