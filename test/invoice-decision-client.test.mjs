import test from "node:test";
import assert from "node:assert/strict";
import {chmod,mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {invokeInvoiceDecision} from "../src/capabilities/invoice/decision-client.mjs";

const fakeCodex=fileURLToPath(new URL("./fixtures/fake-codex.mjs",import.meta.url));
const decision={action:"archive_dining",confidence:"high",reason:"清晰",question:"",invoice:{invoice_number:"123",issue_date:"2026-07-18",buyer_name:"亚信科技（成都）有限公司",buyer_tax_id:"91510100732356360H",seller_name:"餐厅",item_name:"餐饮服务",total_with_tax:"10.00",file_format:"png"},buyer_verification:"exact_match",category:"dining",document_verification:"single_invoice"};

test("invokes Codex read-only with image and sends no Feishu identifiers",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-invoice-ai-"));
  const skillRoot=join(root,".agents","skills","filing-invoices");
  await mkdir(join(skillRoot,"references"),{recursive:true});
  await writeFile(join(skillRoot,"references","output-schema.json"),"{}");
  const image=join(root,"invoice.png"); await writeFile(image,Buffer.from([1])); await chmod(fakeCodex,0o755);
  const argsFile=join(root,"args.json"), stdinFile=join(root,"stdin.txt");
  try {
    const analysisInput={originalFile:image,detectedFormat:"png",archiveExtension:"png",pageImages:[image],extractedText:"",documentFacts:{pageCount:1,textAvailable:false}};
    const result=await invokeInvoiceDecision({codexPath:fakeCodex,workspaceRoot:root,skillRoot,analysisInput,environment:{...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,FAKE_RESPONSE:JSON.stringify(decision)}});
    assert.deepEqual(result,decision);
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    assert.deepEqual(args.slice(0,5),["exec","--ephemeral","--sandbox","read-only","--skip-git-repo-check"]);
    assert.ok(args.includes("--image")); assert.equal(args[args.indexOf("--image")+1],image);
    assert.ok(args.includes("model_reasoning_effort=\"medium\""));
    assert.equal(args[args.indexOf("--output-schema")+1],join(skillRoot,"references","output-schema.json"));
    assert.ok(args.includes("--output-last-message")); assert.equal(args.at(-1),"-");
    const prompt=await readFile(stdinFile,"utf8");
    assert.match(prompt,/\$filing-invoices/); assert.match(prompt,/png/); assert.match(prompt,/不可信数据/);
    for (const secret of ["sender_id","chat_id","message_id","file_key","ou_secret","oc_secret","om_secret","img_secret"]) assert.equal(prompt.includes(secret),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("sends every PDF page in order with bounded untrusted text and both Skills",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-invoice-pdf-ai-"));
  const skillRoot=join(root,".agents","skills","filing-invoices");
  await mkdir(join(skillRoot,"references"),{recursive:true});
  await writeFile(join(skillRoot,"references","output-schema.json"),"{}");
  const pages=[1,2,3].map(number => join(root,`page-${number}.png`));
  for (const page of pages) await writeFile(page,Buffer.from([1]));
  await chmod(fakeCodex,0o755);
  const argsFile=join(root,"args.json"),stdinFile=join(root,"stdin.txt");
  const pdfDecision=structuredClone(decision); pdfDecision.invoice.file_format="pdf";
  const analysisInput={
    originalFile:join(root,"source.pdf"),detectedFormat:"pdf",archiveExtension:"pdf",pageImages:pages,
    extractedText:"SAFE-INVOICE-TEXT",documentFacts:{pageCount:3,textAvailable:true}
  };
  try {
    const result=await invokeInvoiceDecision({codexPath:fakeCodex,workspaceRoot:root,skillRoot,analysisInput,environment:{...process.env,FAKE_ARGS_FILE:argsFile,FAKE_STDIN_FILE:stdinFile,FAKE_RESPONSE:JSON.stringify(pdfDecision)}});
    assert.deepEqual(result,pdfDecision);
    const args=JSON.parse(await readFile(argsFile,"utf8"));
    const actualPages=[];
    for (let index=0;index<args.length;index++) if (args[index] === "--image") actualPages.push(args[index+1]);
    assert.deepEqual(actualPages,pages);
    const prompt=await readFile(stdinFile,"utf8");
    assert.match(prompt,/\$pdf/); assert.match(prompt,/\$filing-invoices/);
    assert.match(prompt,/总页数：3/); assert.match(prompt,/文本层：有/);
    assert.match(prompt,/BEGIN UNTRUSTED EXTRACTED TEXT/); assert.match(prompt,/SAFE-INVOICE-TEXT/);
    assert.match(prompt,/检查每一页/); assert.match(prompt,/single_invoice/);
    for (const secret of ["ou_secret","oc_secret","om_secret","file_secret"]) assert.equal(prompt.includes(secret),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("retries one transient Codex nonzero exit and returns the second valid decision",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-invoice-ai-retry-"));
  const skillRoot=join(root,".agents","skills","filing-invoices");
  await mkdir(join(skillRoot,"references"),{recursive:true});
  await writeFile(join(skillRoot,"references","output-schema.json"),"{}");
  const image=join(root,"invoice.png");
  await writeFile(image,Buffer.from([1]));
  await chmod(fakeCodex,0o755);
  const attemptsFile=join(root,"attempts.txt");
  const analysisInput={originalFile:image,detectedFormat:"png",archiveExtension:"png",pageImages:[image],extractedText:"",documentFacts:{pageCount:1,textAvailable:false}};
  try {
    const result=await invokeInvoiceDecision({
      codexPath:fakeCodex,workspaceRoot:root,skillRoot,analysisInput,maxAttempts:2,retryDelayMs:1,
      environment:{...process.env,FAKE_CODEX_MODE:"transient",FAKE_CODEX_ATTEMPTS:attemptsFile,FAKE_RESPONSE:JSON.stringify(decision)}
    });
    assert.deepEqual(result,decision);
    assert.equal(await readFile(attemptsFile,"utf8"),"2");
  } finally { await rm(root,{recursive:true,force:true}); }
});

test("rejects inconsistent internal analysis input before spawning Codex",async () => {
  const root=await mkdtemp(join(tmpdir(),"llw-invoice-invalid-ai-"));
  const skillRoot=join(root,"skill");
  const image=join(root,"page-1.png");
  await mkdir(join(skillRoot,"references"),{recursive:true});
  await writeFile(join(skillRoot,"references","output-schema.json"),"{}");
  await writeFile(image,"x");
  const analysisInput={originalFile:join(root,"source.pdf"),detectedFormat:"pdf",archiveExtension:"pdf",pageImages:[image],extractedText:"text",documentFacts:{pageCount:2,textAvailable:true}};
  try {
    await assert.rejects(() => invokeInvoiceDecision({codexPath:fakeCodex,workspaceRoot:root,skillRoot,analysisInput}),/invalid_analysis_input/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
