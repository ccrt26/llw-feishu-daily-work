import {execFile} from "node:child_process";
import {promisify} from "node:util";

const run=promisify(execFile);
const KEYCHAIN_NAME=/^[A-Za-z0-9._@-]{1,128}$/u;

export async function readKeychainPassword({
  service,account,execute=run
}={}) {
  try {
    if (!KEYCHAIN_NAME.test(service||"")||
        !KEYCHAIN_NAME.test(account||"")||
        typeof execute!=="function") {
      throw new Error("invalid");
    }
    const {stdout}=await execute("/usr/bin/security",[
      "find-generic-password","-w",
      "-s",service,
      "-a",account
    ],{encoding:"utf8",maxBuffer:8192});
    if (typeof stdout!=="string") throw new Error("invalid");
    const password=stdout.replace(/\r?\n$/u,"");
    if (!password||Buffer.byteLength(password,"utf8")>4096||
        password.includes("\n")||password.includes("\r")) {
      throw new Error("invalid");
    }
    return password;
  } catch {
    throw new Error("keychain_password_unavailable");
  }
}
