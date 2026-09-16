import test from 'node:test';
import assert from 'node:assert/strict';
import { runKbDemo } from '../../tools/kb-demo.ts';

test('repository intake, explicit human approval and model release respect withdrawal end to end',async()=>{
  const result=await runKbDemo();
  assert.equal(result.no_shared_write_on_import,true);
  assert.equal(result.before_approval,'withheld');assert.equal(result.after_approval,'provided');
  assert.equal(result.withdrawal_during_generation,'withheld');assert.equal(result.withdrawn_output_returned,false);
  assert.equal(result.repeat_skipped,1);assert.equal(result.model_calls,2);
});
