import test from "node:test";
import assert from "node:assert/strict";
import { createPerchProvider } from "../src/provider.js";
import { createClient } from "../src/http.js";
import { backend, openAICompletionsApi, json, run } from "./helpers.js";

for (const [status, enforced, allowed] of [[500,false,true],[500,true,false],[500,undefined,false],[401,false,false],[403,false,false],[429,false,false]]) {
  test(`ticket HTTP ${status} enforced=${enforced}: advisory fallback=${allowed}`, async () => {
    const b = backend(undefined, call => call.url.endsWith("/turn-ticket") ? json({ ok:false,error:"mint_failed",...(enforced===undefined?{}:{enforced}) },status) : undefined);
    const p = createPerchProvider({ api:openAICompletionsApi(),fetch:b.fetch });
    const { result } = await run(p);
    assert.equal(result.stopReason, allowed ? "stop" : "error");
    const calls=b.calls.filter(call=>call.url.endsWith("/model-call"));
    assert.equal(calls.length, allowed ? 1 : 0);
    if (allowed) {
      assert.equal(calls[0].init.headers.get("x-perch-turn-ticket"), null);
      assert.equal(calls[0].init.headers.get("Authorization"), "Bearer TOKEN");
      assert(calls[0].body.runId);
    }
  });
}

test("unknown ticket timeout never infers enforced:false", async () => {
  const b=backend(undefined,call=>{if(call.url.endsWith("/turn-ticket"))throw new DOMException("Timed out","TimeoutError");});
  const p=createPerchProvider({api:openAICompletionsApi(),fetch:b.fetch});
  const {result}=await run(p);
  assert.equal(result.stopReason,"error");assert.equal(b.calls.length,1);
});

test("advisory fallback retains the standard turn budget", async () => {
  const b=backend(undefined,call=>call.url.endsWith("/turn-ticket")?json({ok:false,error:"mint_failed",enforced:false},500):undefined);
  const p=createPerchProvider({api:openAICompletionsApi(),fetch:b.fetch});
  for(let i=0;i<40;i++)assert.equal((await run(p,{sessionId:"same-turn"})).result.stopReason,"stop");
  const {result}=await run(p,{sessionId:"same-turn"});
  assert.equal(result.stopReason,"error");assert.match(result.errorMessage,/budget exhausted/);
  assert.equal(b.calls.filter(call=>call.url.endsWith("/model-call")).length,40);
});

test("control request timeout includes the stage and deadline", async () => {
  const client=createClient({fetch:async(_url,init)=>new Promise((_resolve,reject)=>{
    init.signal.addEventListener("abort",()=>reject(init.signal.reason),{once:true});
  })});
  const pending=client.json("/api/perch-terminal/turn-ticket",{timeoutMs:5});
  // AbortSignal.timeout is unref'd; keep only this test alive until its deadline.
  const timer=setTimeout(()=>{},1000);
  try {
    await assert.rejects(pending,error=>error.code==="perch_request_timeout"&&/turn-ticket/.test(error.message)&&/5ms/.test(error.message));
  } finally {clearTimeout(timer);}
});
