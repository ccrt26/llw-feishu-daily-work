import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {buildFixtureManifest} from "../scripts/create-v410-media-fixtures.mjs";
import {
  evaluateGateResult,renderGateReport
} from "../scripts/v410-media-capability-gate.mjs";

test("fixture manifest labels synthetic bytes as fixed non-private facts",async()=>{
  const root=await mkdtemp(join(tmpdir(),"llw-v410-media-fixtures-"));
  const audio=join(root,"instruction.aiff");
  const video=join(root,"visual-facts.mov");
  await writeFile(audio,Buffer.alloc(1_024,1));
  await writeFile(video,Buffer.alloc(2_048,2));
  const manifest=await buildFixtureManifest({audio,video});
  assert.deepEqual(manifest.expectedVisualSequence,[
    "circle","square","triangle"
  ]);
  assert.equal(manifest.visualOnlyCode,"BLUE-7319");
  assert.equal(manifest.audioPhrase,"请把测试代号海风七三一九记录下来");
  assert.equal(manifest.containsUserData,false);
  assert.equal(manifest.visualOnlyCodeSpoken,false);
  assert.equal(manifest.sequenceSpoken,false);
  assert.equal(manifest.files.audio,"instruction.aiff");
  assert.equal(manifest.files.video,"visual-facts.mov");
  assert.match(manifest.sha256.audio,/^[a-f0-9]{64}$/u);
  assert.match(manifest.sha256.video,/^[a-f0-9]{64}$/u);
});

test("gate passes only direct audio, visual fact, order and timing evidence",()=>{
  const result=evaluateGateResult({
    audioPhrase:"请把测试代号海风七三一九记录下来",
    visualCode:"BLUE-7319",
    visualSequence:["circle","square","triangle"],
    codeTimeRangeMs:{start:5_100,end:6_900},
    directlyInspectedAudio:true,
    directlyInspectedVideo:true,
    limitations:[]
  });
  assert.equal(result.mandatoryPassed,true);
  assert.equal(result.directMediaSupported,true);
  assert.deepEqual(
    result.cases.map(item=>[item.id,item.status]),
    [
      ["audio_instruction","pass"],
      ["video_visual_only_fact","pass"],
      ["video_temporal_order","pass"],
      ["video_time_lookup","pass"]
    ]
  );
});

test("gate marks an admitted inability as unsupported instead of guessing",()=>{
  const result=evaluateGateResult({
    audioPhrase:null,
    visualCode:null,
    visualSequence:[],
    codeTimeRangeMs:null,
    directlyInspectedAudio:false,
    directlyInspectedVideo:false,
    limitations:["The CLI has no audio or video attachment input."]
  });
  assert.equal(result.mandatoryPassed,false);
  assert.equal(result.directMediaSupported,false);
  assert.ok(result.cases.every(item=>item.status==="unsupported"));
});

test("gate report contains evidence status without private absolute paths",()=>{
  const report=renderGateReport({
    environment:{
      codexVersion:"codex-cli test",
      nodeVersion:"v24.0.0",
      invocationMode:"one read-only Codex call"
    },
    elapsedMs:123,
    result:evaluateGateResult({
      audioPhrase:null,
      visualCode:null,
      visualSequence:[],
      codeTimeRangeMs:null,
      directlyInspectedAudio:false,
      directlyInspectedVideo:false,
      limitations:["Could not inspect /Users/private/source.mov"]
    })
  });
  assert.match(report,/Decision: STOP_AFTER_FOUNDATION/u);
  assert.doesNotMatch(report,/\/Users\/private/u);
  assert.match(report,/<absolute-path>/u);
});
