import test from "node:test";
import assert from "node:assert/strict";
import {
  readKeychainPassword
} from "../src/core/keychain-password-reader.mjs";

test("reads one bounded password with fixed security argv",async()=>{
  const calls=[];
  const value=await readKeychainPassword({
    service:"com.llw.deepseek-api",
    account:"llw-assistant",
    execute:async(command,args,options)=>{
      calls.push({command,args,options});
      return {stdout:"synthetic-secret\n"};
    }
  });
  assert.equal(value,"synthetic-secret");
  assert.deepEqual(calls,[{
    command:"/usr/bin/security",
    args:[
      "find-generic-password","-w",
      "-s","com.llw.deepseek-api",
      "-a","llw-assistant"
    ],
    options:{encoding:"utf8",maxBuffer:8192}
  }]);
});

test("rejects names and unsafe password output with one neutral error",async()=>{
  const invalid=[
    {service:"",account:"llw-assistant",stdout:"secret"},
    {service:"bad service",account:"llw-assistant",stdout:"secret"},
    {service:"safe",account:"../account",stdout:"secret"},
    {service:"safe",account:"account",stdout:""},
    {service:"safe",account:"account",stdout:"two\nlines\n"},
    {service:"safe",account:"account",stdout:"x".repeat(4097)}
  ];
  for (const value of invalid) {
    let calls=0;
    await assert.rejects(
      readKeychainPassword({
        ...value,
        execute:async()=>{
          calls+=1;
          return {stdout:value.stdout};
        }
      }),
      {message:"keychain_password_unavailable"}
    );
    if (!/^[A-Za-z0-9._@-]{1,128}$/u.test(value.service)||
        !/^[A-Za-z0-9._@-]{1,128}$/u.test(value.account)) {
      assert.equal(calls,0);
    }
  }
  await assert.rejects(
    readKeychainPassword({
      service:"safe",account:"account",
      execute:async()=>{throw new Error("private keychain detail");}
    }),
    {message:"keychain_password_unavailable"}
  );
});
