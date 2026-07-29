import test from "node:test";
import assert from "node:assert/strict";
import {
  validateSourceReadRequest
} from "../src/personal-assistant/source-read-request.mjs";

const sources=[{
  sourceId:"source-001",mediaClass:"video",durationMs:120_000
}];

test("accepts only bounded observations of one already prepared source",()=>{
  const requests=validateSourceReadRequest({
    raw:[
      {sourceId:"source-001",view:"probe_media"},
      {
        sourceId:"source-001",view:"inspect_time_range",
        startMs:10_000,endMs:30_000
      }
    ],
    availableSources:sources
  });
  assert.deepEqual(requests,[
    {sourceId:"source-001",view:"probe_media"},
    {
      sourceId:"source-001",view:"inspect_time_range",
      startMs:10_000,endMs:30_000
    }
  ]);
  assert.equal(Object.isFrozen(requests),true);
  assert.equal(Object.isFrozen(requests[0]),true);
});

test("rejects paths, commands, URLs, unknown sources and unbounded ranges",()=>{
  const invalid=[
    [{sourceId:"source-001",view:"probe_media",path:"/private/file"}],
    [{sourceId:"source-001",view:"probe_media",command:"ffmpeg"}],
    [{sourceId:"source-001",view:"probe_media",url:"https://example.com"}],
    [{sourceId:"source-002",view:"probe_media"}],
    [{sourceId:"source-001",view:"arbitrary"}],
    [{
      sourceId:"source-001",view:"inspect_time_range",
      startMs:0,endMs:60_001
    }],
    [{sourceId:"source-001",view:"probe_media",startMs:0,endMs:1}],
    Array.from({length:9},()=>({
      sourceId:"source-001",view:"probe_media"
    }))
  ];
  for (const raw of invalid) {
    assert.throws(
      ()=>validateSourceReadRequest({raw,availableSources:sources}),
      /source_read_request_invalid/u
    );
  }
});

test("does not allow one observation envelope to consume two heavy sources",()=>{
  assert.throws(()=>validateSourceReadRequest({
    raw:[
      {sourceId:"source-001",view:"probe_media"},
      {sourceId:"source-002",view:"probe_media"}
    ],
    availableSources:[
      ...sources,
      {sourceId:"source-002",mediaClass:"audio",durationMs:60_000}
    ]
  }),/source_read_request_invalid/u);
});
