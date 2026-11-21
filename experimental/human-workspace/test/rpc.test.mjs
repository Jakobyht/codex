import { test } from "node:test";
import assert from "node:assert/strict";
import { CodexRpc } from "../codex-rpc.mjs";

test("Codex transport initializes and follows a turn through completion", async () => {
  const program = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;process.stdout.write(JSON.stringify({id:m.id,result:m.method==='initialize'?{ok:true}:{turn:{id:'turn-test',status:'inProgress'}}})+'\\n');if(m.method==='turn/start'){process.stdout.write(JSON.stringify({method:'item/agentMessage/delta',params:{threadId:'thread-test',delta:'A review'}})+'\\n');process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'thread-test',turn:{id:'turn-test',status:'completed'}}})+'\\n');}});`;
  const rpc = new CodexRpc({ command: process.execPath, args: ["-e", program] });
  try {
    assert.deepEqual(await rpc.initialize(), { ok: true });
    const completion = rpc.waitForTurn("thread-test", 1000);
    const ack = await rpc.request("turn/start", { threadId: "thread-test", input: [] });
    assert.equal(ack.turn.id, "turn-test");
    const result = await completion; assert.equal(result.turn.status, "completed"); assert.equal(result.text, "A review");
  } finally { await rpc.close(); }
});
