/*
 * cpu.js - core of the CPU instruction cycle simulator.
 * No DOM code in here, so the same file runs in the browser and under Node (for the tests).
 *
 * The machine is a small accumulator CPU. One instruction word is 16 bits:
 *     [ opcode : 8 bits ][ operand : 8 bits ]
 * Data words use the same 16-bit width. Memory size is configurable.
 */
(function (root) {
  'use strict';

  var WORD_MASK = 0xFFFF;

  // mnemonic -> { code, operand? , text }
  var ISA = {
    NOP:   { code: 0x00, operand: false, text: 'do nothing' },
    HLT:   { code: 0x01, operand: false, text: 'stop the CPU' },
    LDI:   { code: 0x02, operand: true,  text: 'ACC <- operand (immediate value)' },
    LOAD:  { code: 0x03, operand: true,  text: 'ACC <- M[addr]' },
    STORE: { code: 0x04, operand: true,  text: 'M[addr] <- ACC' },
    ADD:   { code: 0x05, operand: true,  text: 'ACC <- ACC + M[addr]' },
    SUB:   { code: 0x06, operand: true,  text: 'ACC <- ACC - M[addr]' },
    INC:   { code: 0x07, operand: false, text: 'ACC <- ACC + 1' },
    DEC:   { code: 0x08, operand: false, text: 'ACC <- ACC - 1' },
    JMP:   { code: 0x09, operand: true,  text: 'PC <- addr' },
    JZ:    { code: 0x0A, operand: true,  text: 'if Z = 1 then PC <- addr' },
    JNZ:   { code: 0x0B, operand: true,  text: 'if Z = 0 then PC <- addr' },
    OUT:   { code: 0x0C, operand: false, text: 'send ACC to the output port' }
  };
  var BY_CODE = {};
  Object.keys(ISA).forEach(function (m) { BY_CODE[ISA[m].code] = m; });

  function toWord(n) { return n & WORD_MASK; }

  /* ---------------------------------------------------------------- assembler */
  function assemble(source, memSize) {
    var lines = source.split(/\r?\n/);
    var labels = {};
    var items = [];          // { kind:'ins'|'data', mnem, arg, line }
    var addr = 0, i, errors = [];

    // pass 1: collect labels, count words
    for (i = 0; i < lines.length; i++) {
      var raw = lines[i].replace(/;.*$/, '').trim();
      if (!raw) continue;
      var m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
      if (m) {
        if (labels.hasOwnProperty(m[1].toUpperCase())) errors.push('Line ' + (i + 1) + ': label "' + m[1] + '" defined twice');
        labels[m[1].toUpperCase()] = addr;
        raw = m[2].trim();
        if (!raw) continue;
      }
      var parts = raw.split(/\s+/);
      var op = parts[0].toUpperCase();
      if (op === 'DB' || op === 'DW') {
        items.push({ kind: 'data', arg: parts[1], line: i + 1 });
        addr++;
      } else if (ISA[op]) {
        items.push({ kind: 'ins', mnem: op, arg: parts[1], line: i + 1 });
        addr++;
      } else {
        errors.push('Line ' + (i + 1) + ': unknown instruction "' + parts[0] + '"');
      }
    }
    if (addr > memSize) errors.push('Program needs ' + addr + ' words but memory only has ' + memSize + '.');

    function value(arg, line) {
      if (arg === undefined) { errors.push('Line ' + line + ': missing operand'); return 0; }
      var up = arg.toUpperCase();
      if (labels.hasOwnProperty(up)) return labels[up];
      var n = /^0x/i.test(arg) ? parseInt(arg, 16) : Number(arg);
      if (isNaN(n)) { errors.push('Line ' + line + ': cannot understand "' + arg + '"'); return 0; }
      return n;
    }

    // pass 2: encode
    var words = [], dataAddrs = [];
    items.forEach(function (it) {
      if (it.kind === 'data') {
        dataAddrs.push(words.length);
        words.push(toWord(value(it.arg, it.line)));
      } else {
        var spec = ISA[it.mnem];
        var operand = 0;
        if (spec.operand) {
          operand = value(it.arg, it.line);
          if (operand < 0 || operand > 255) { errors.push('Line ' + it.line + ': operand ' + operand + ' does not fit in 8 bits'); operand = 0; }
        } else if (it.arg !== undefined) {
          errors.push('Line ' + it.line + ': ' + it.mnem + ' does not take an operand');
        }
        words.push((spec.code << 8) | operand);
      }
    });
    return { words: words, labels: labels, errors: errors, dataAddrs: dataAddrs };
  }

  function disassemble(word) {
    var code = (word >> 8) & 0xFF, operand = word & 0xFF;
    var m = BY_CODE[code];
    if (!m) return 'DATA ' + word;
    return ISA[m].operand ? m + ' ' + operand : m;
  }

  /* --------------------------------------------------------------------- CPU */
  /*
   * opts.memSize     number of words in memory
   * opts.memLatency  clock cycles taken by one memory read or write (>= 1)
   */
  function CPU(opts) {
    opts = opts || {};
    this.memSize = opts.memSize || 32;
    this.memLatency = Math.max(1, opts.memLatency || 1);
    this.reset();
  }

  CPU.prototype.reset = function () {
    this.mem = new Array(this.memSize).fill(0);
    this.softReset();
  };

  // keep memory contents, restart execution
  CPU.prototype.softReset = function () {
    this.reg = { PC: 0, MAR: 0, MDR: 0, IR: 0, ACC: 0 };
    this.flags = { Z: 0, N: 0, C: 0 };
    this.halted = false;
    this.error = null;
    this.cycles = 0;
    this.instrCount = 0;
    this.output = [];
    this.queue = [];          // micro-operations still to run for the current instruction
    this.phase = 'FETCH';
    this.decoded = null;
    this.microCount = 0;
  };

  CPU.prototype.load = function (words) {
    this.mem = new Array(this.memSize).fill(0);
    for (var i = 0; i < words.length && i < this.memSize; i++) this.mem[i] = words[i];
    this.softReset();
  };

  CPU.prototype._setFlags = function (result, carry) {
    this.flags.Z = (result & WORD_MASK) === 0 ? 1 : 0;
    this.flags.N = (result & 0x8000) ? 1 : 0;
    this.flags.C = carry ? 1 : 0;
  };

  // build the three fetch micro-operations
  CPU.prototype._startInstruction = function () {
    var self = this, lat = this.memLatency;
    this.phase = 'FETCH';
    this.decoded = null;
    this.queue = [
      { phase: 'FETCH', label: 'MAR <- PC', touch: ['PC', 'MAR'], cost: 1,
        run: function () { self.reg.MAR = self.reg.PC; },
        text: function () { return 'Copy the program counter into the memory address register. MAR = ' + self.reg.MAR; } },
      { phase: 'FETCH', label: 'MDR <- M[MAR] ; PC <- PC + 1', touch: ['MAR', 'MEM', 'MDR', 'PC'], cost: lat,
        run: function () {
          if (self.reg.MAR >= self.memSize) { self.halted = true; self.error = 'MAR points outside memory'; return; }
          self.reg.MDR = self.mem[self.reg.MAR];
          self.reg.PC = (self.reg.PC + 1) & 0xFF;
        },
        text: function () { return 'Read the word at address ' + self.reg.MAR + ' into MDR (' + hex(self.reg.MDR) + ') and step PC to ' + self.reg.PC + '.'; } },
      { phase: 'FETCH', label: 'IR <- MDR', touch: ['MDR', 'IR'], cost: 1,
        run: function () { self.reg.IR = self.reg.MDR; },
        text: function () { return 'Move the fetched word into the instruction register. IR = ' + hex(self.reg.IR) + '.'; } },
      { phase: 'DECODE', label: 'decode IR', touch: ['IR', 'CU'], cost: 1,
        run: function () {
          var code = (self.reg.IR >> 8) & 0xFF, operand = self.reg.IR & 0xFF;
          var mnem = BY_CODE[code];
          if (!mnem) { self.halted = true; self.error = 'Illegal opcode ' + hex(code); self.decoded = { mnem: '???', operand: 0 }; return; }
          self.decoded = { mnem: mnem, operand: operand };
          self.queue = self.queue.concat(self._executeOps(mnem, operand));
        },
        text: function () {
          var d = self.decoded;
          if (!d || d.mnem === '???') return 'Illegal opcode - CPU halts.';
          return 'Control unit splits IR into opcode ' + hex8(ISA[d.mnem].code) + ' (' + d.mnem + ') and operand ' + d.operand + '.';
        } }
    ];
  };

  CPU.prototype._executeOps = function (mnem, operand) {
    var self = this, lat = this.memLatency, ops = [];
    function op(label, touch, cost, run, text) {
      ops.push({ phase: 'EXECUTE', label: label, touch: touch, cost: cost, run: run, text: text });
    }
    switch (mnem) {
      case 'NOP':
        op('no operation', ['CU'], 1, function () {}, function () { return 'Nothing to do.'; });
        break;
      case 'HLT':
        op('halt', ['CU'], 1, function () { self.halted = true; }, function () { return 'CPU stops. Final state is shown on the left.'; });
        break;
      case 'LDI':
        op('ACC <- operand', ['IR', 'ACC'], 1,
          function () { self.reg.ACC = operand; self._setFlags(operand, 0); },
          function () { return 'Load the constant ' + operand + ' straight into the accumulator.'; });
        break;
      case 'LOAD':
        op('MAR <- operand', ['IR', 'MAR'], 1, function () { self.reg.MAR = operand; },
          function () { return 'Put the operand address ' + operand + ' into MAR.'; });
        op('MDR <- M[MAR]', ['MAR', 'MEM', 'MDR'], lat, function () { self.reg.MDR = self._read(self.reg.MAR); },
          function () { return 'Read memory at ' + self.reg.MAR + ' = ' + self.reg.MDR + ' into MDR.'; });
        op('ACC <- MDR', ['MDR', 'ACC'], 1, function () { self.reg.ACC = self.reg.MDR; self._setFlags(self.reg.ACC, 0); },
          function () { return 'Copy MDR into the accumulator. ACC = ' + self.reg.ACC + '.'; });
        break;
      case 'STORE':
        op('MAR <- operand', ['IR', 'MAR'], 1, function () { self.reg.MAR = operand; },
          function () { return 'Put the operand address ' + operand + ' into MAR.'; });
        op('MDR <- ACC', ['ACC', 'MDR'], 1, function () { self.reg.MDR = self.reg.ACC; },
          function () { return 'Copy the accumulator (' + self.reg.ACC + ') into MDR.'; });
        op('M[MAR] <- MDR', ['MDR', 'MAR', 'MEM'], lat, function () { self._write(self.reg.MAR, self.reg.MDR); },
          function () { return 'Write ' + self.reg.MDR + ' into memory address ' + self.reg.MAR + '.'; });
        break;
      case 'ADD':
      case 'SUB':
        op('MAR <- operand', ['IR', 'MAR'], 1, function () { self.reg.MAR = operand; },
          function () { return 'Put the operand address ' + operand + ' into MAR.'; });
        op('MDR <- M[MAR]', ['MAR', 'MEM', 'MDR'], lat, function () { self.reg.MDR = self._read(self.reg.MAR); },
          function () { return 'Read memory at ' + self.reg.MAR + ' = ' + self.reg.MDR + ' into MDR.'; });
        op(mnem === 'ADD' ? 'ACC <- ACC + MDR' : 'ACC <- ACC - MDR', ['ACC', 'MDR', 'ALU'], 1,
          function () {
            var a = self.reg.ACC, b = self.reg.MDR, r;
            if (mnem === 'ADD') { r = a + b; self._setFlags(r, r > WORD_MASK); }
            else { r = a - b; self._setFlags(r, a < b); }
            self.reg.ACC = toWord(r);
          },
          function () { return 'ALU ' + (mnem === 'ADD' ? 'adds' : 'subtracts') + ' MDR ' + (mnem === 'ADD' ? 'to' : 'from') + ' ACC. ACC = ' + self.reg.ACC + ', flags Z=' + self.flags.Z + ' N=' + self.flags.N + ' C=' + self.flags.C + '.'; });
        break;
      case 'INC':
      case 'DEC':
        op(mnem === 'INC' ? 'ACC <- ACC + 1' : 'ACC <- ACC - 1', ['ACC', 'ALU'], 1,
          function () {
            var r = self.reg.ACC + (mnem === 'INC' ? 1 : -1);
            self._setFlags(r, r > WORD_MASK || r < 0);
            self.reg.ACC = toWord(r);
          },
          function () { return 'ALU changes ACC by ' + (mnem === 'INC' ? '+1' : '-1') + '. ACC = ' + self.reg.ACC + ', Z=' + self.flags.Z + '.'; });
        break;
      case 'JMP':
        op('PC <- operand', ['IR', 'PC'], 1, function () { self.reg.PC = operand; },
          function () { return 'Unconditional jump. PC = ' + operand + '.'; });
        break;
      case 'JZ':
      case 'JNZ':
        op('if ' + (mnem === 'JZ' ? 'Z=1' : 'Z=0') + ' then PC <- operand', ['IR', 'PC', 'CU'], 1,
          function () {
            var take = mnem === 'JZ' ? self.flags.Z === 1 : self.flags.Z === 0;
            self._branchTaken = take;
            if (take) self.reg.PC = operand;
          },
          function () { return 'Z flag is ' + self.flags.Z + ', so the branch is ' + (self._branchTaken ? 'taken. PC = ' + operand + '.' : 'not taken. PC stays ' + self.reg.PC + '.'); });
        break;
      case 'OUT':
        op('OUT <- ACC', ['ACC', 'OUT'], 1, function () { self.output.push(self.reg.ACC); },
          function () { return 'ACC (' + self.reg.ACC + ') sent to the output port.'; });
        break;
    }
    return ops;
  };

  CPU.prototype._read = function (a) {
    if (a >= this.memSize) { this.halted = true; this.error = 'Read outside memory at ' + a; return 0; }
    return this.mem[a];
  };
  CPU.prototype._write = function (a, v) {
    if (a >= this.memSize) { this.halted = true; this.error = 'Write outside memory at ' + a; return; }
    this.mem[a] = toWord(v);
    this.lastWrite = a;
  };

  /*
   * Run exactly one micro-operation. Returns a record describing it,
   * or null when the CPU has halted.
   */
  CPU.prototype.stepMicro = function () {
    if (this.halted) return null;
    if (this.queue.length === 0) this._startInstruction();
    var mo = this.queue.shift();
    this.phase = mo.phase;
    var before = snapshot(this);
    this.lastWrite = null;
    mo.run();
    this.cycles += mo.cost;
    this.microCount++;
    var rec = {
      phase: mo.phase, label: mo.label, touch: mo.touch, cost: mo.cost,
      text: mo.text(), before: before, after: snapshot(this),
      instrIndex: this.instrCount,
      endsInstruction: this.queue.length === 0
    };
    if (this.queue.length === 0 && !this.error) this.instrCount++;
    return rec;
  };

  // run micro-operations until one whole instruction has completed
  CPU.prototype.stepInstruction = function () {
    var recs = [], r;
    do {
      r = this.stepMicro();
      if (r) recs.push(r);
    } while (r && !r.endsInstruction);
    return recs;
  };

  function snapshot(c) {
    return { reg: Object.assign({}, c.reg), flags: Object.assign({}, c.flags) };
  }
  function hex(n) { return '0x' + ('0000' + (n & 0xFFFF).toString(16).toUpperCase()).slice(-4); }
  function hex8(n) { return '0x' + ('00' + (n & 0xFF).toString(16).toUpperCase()).slice(-2); }

  /* ------------------------------------------------------ sample programs */
  var SAMPLES = {
    'Add two numbers': [
      '; C = A + B',
      '      LOAD A',
      '      ADD  B',
      '      STORE C',
      '      OUT',
      '      HLT',
      'A:    DB 25',
      'B:    DB 17',
      'C:    DB 0'
    ].join('\n'),
    'Sum of 1 to 5 (loop)': [
      '; sum = 5 + 4 + 3 + 2 + 1',
      '      LDI 5',
      '      STORE N',
      'LOOP: LOAD SUM',
      '      ADD  N',
      '      STORE SUM',
      '      LOAD N',
      '      DEC',
      '      STORE N',
      '      JNZ LOOP',
      '      LOAD SUM',
      '      OUT',
      '      HLT',
      'N:    DB 0',
      'SUM:  DB 0'
    ].join('\n'),
    'Multiply 6 x 7 (repeated add)': [
      '; RESULT = X * Y using repeated addition',
      '      LDI 7',
      '      STORE CNT',
      'LOOP: LOAD RES',
      '      ADD  X',
      '      STORE RES',
      '      LOAD CNT',
      '      DEC',
      '      STORE CNT',
      '      JNZ LOOP',
      '      LOAD RES',
      '      OUT',
      '      HLT',
      'X:    DB 6',
      'CNT:  DB 0',
      'RES:  DB 0'
    ].join('\n'),
    'Countdown 3..0': [
      '      LDI 3',
      'TOP:  OUT',
      '      DEC',
      '      JNZ TOP',
      '      OUT',
      '      HLT'
    ].join('\n')
  };

  var api = { CPU: CPU, assemble: assemble, disassemble: disassemble, ISA: ISA, SAMPLES: SAMPLES, hex: hex };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CPUSim = api;
})(typeof window !== 'undefined' ? window : this);
