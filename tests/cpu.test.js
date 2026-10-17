// Run with:  node tests/cpu.test.js
const assert = require('assert');
const { CPU, assemble, SAMPLES } = require('../cpu.js');

function run(src, opts) {
  const cpu = new CPU(opts || { memSize: 32, memLatency: 1 });
  const asm = assemble(src, cpu.memSize);
  assert.deepStrictEqual(asm.errors, [], 'assembler errors: ' + asm.errors.join('; '));
  cpu.load(asm.words);
  let guard = 0;
  while (!cpu.halted && guard++ < 5000) cpu.stepInstruction();
  assert.ok(cpu.halted, 'program did not halt');
  return { cpu, asm };
}

// 1. add two numbers
let r = run(SAMPLES['Add two numbers']);
assert.deepStrictEqual(r.cpu.output, [42]);
assert.strictEqual(r.cpu.mem[r.asm.labels.C], 42);

// 2. loop sum
r = run(SAMPLES['Sum of 1 to 5 (loop)']);
assert.deepStrictEqual(r.cpu.output, [15]);

// 3. multiply
r = run(SAMPLES['Multiply 6 x 7 (repeated add)']);
assert.deepStrictEqual(r.cpu.output, [42]);

// 4. countdown
r = run(SAMPLES['Countdown 3..0']);
assert.deepStrictEqual(r.cpu.output, [3, 2, 1, 0]);

// 5. every instruction does fetch (3 micro-ops) + decode (1) + its execute ops
const c = new CPU({ memSize: 16, memLatency: 1 });
c.load(assemble('LDI 9\nHLT', 16).words);
let recs = c.stepInstruction();
assert.deepStrictEqual(recs.map(x => x.phase), ['FETCH', 'FETCH', 'FETCH', 'DECODE', 'EXECUTE']);
assert.strictEqual(c.reg.ACC, 9);
assert.strictEqual(c.reg.PC, 1);

// 6. memory latency changes the cycle count but not the answer
const fast = run(SAMPLES['Add two numbers'], { memSize: 32, memLatency: 1 });
const slow = run(SAMPLES['Add two numbers'], { memSize: 32, memLatency: 4 });
assert.deepStrictEqual(fast.cpu.output, slow.cpu.output);
assert.ok(slow.cpu.cycles > fast.cpu.cycles);
// LOAD,ADD,STORE each = 1 fetch-read + 1 data access; HLT/OUT only the fetch read -> 5 fetch reads + 3 data = 8 mem ops
assert.strictEqual(slow.cpu.cycles - fast.cpu.cycles, 8 * 3);

// 7. flags
const f = new CPU({ memSize: 16 });
f.load(assemble('LDI 1\nDEC\nHLT', 16).words);
while (!f.halted) f.stepInstruction();
assert.strictEqual(f.flags.Z, 1);
const g = new CPU({ memSize: 16 });
g.load(assemble('LDI 0\nDEC\nHLT', 16).words);
while (!g.halted) g.stepInstruction();
assert.strictEqual(g.reg.ACC, 0xFFFF);
assert.strictEqual(g.flags.N, 1);

// 8. assembler errors are reported, not thrown
assert.ok(assemble('FOO 1', 16).errors.length === 1);
assert.ok(assemble('LDI 300', 16).errors.length === 1);
assert.ok(assemble('JMP NOWHERE', 16).errors.length === 1);

// 9. smaller memory still works when the program fits
r = run(SAMPLES['Countdown 3..0'], { memSize: 8, memLatency: 1 });
assert.deepStrictEqual(r.cpu.output, [3, 2, 1, 0]);

console.log('cpu.test.js: all checks passed');
