(function () {
  'use strict';
  var S = CPUSim;
  var $ = function (id) { return document.getElementById(id); };

  var cpu, labels = {}, dataAddrs = [], progLen = 0, timer = null, lastRec = null;

  /* ------------------------------------------------------------ number format */
  function fmt(n) {
    var b = Number($('base').value);
    if (b === 16) return '0x' + ('0000' + n.toString(16).toUpperCase()).slice(-4);
    if (b === 2) return ('0000000000000000' + n.toString(2)).slice(-16).replace(/(.{4})/g, '$1 ').trim();
    return String(n);
  }

  /* --------------------------------------------------------- block diagram */
  var BOXES = {
    PC:  [20, 20, 86, 42],  MAR: [150, 20, 86, 42], MEM: [290, 8, 120, 66, 'Main memory'],
    MDR: [460, 20, 86, 42], IR:  [600, 20, 86, 42],
    OUT: [20, 190, 86, 42], ACC: [150, 190, 86, 42], ALU: [290, 190, 120, 42], CU: [600, 190, 86, 42, 'Control unit']
  };
  var LINES = [
    ['PC', 'MAR'], ['MAR', 'MEM'], ['MEM', 'MDR'], ['MDR', 'IR'], ['IR', 'CU'],
    ['MDR', 'ALU'], ['ACC', 'ALU'], ['ACC', 'OUT']
  ];
  function center(id, side) {
    var b = BOXES[id];
    if (side === 'r') return [b[0] + b[2], b[1] + b[3] / 2];
    if (side === 'l') return [b[0], b[1] + b[3] / 2];
    if (side === 'b') return [b[0] + b[2] / 2, b[1] + b[3]];
    return [b[0] + b[2] / 2, b[1]];
  }
  function buildDiagram() {
    var s = '<svg viewBox="0 0 706 250" width="100%" role="img" aria-label="CPU block diagram">';
    s += '<defs><marker id="ar" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="var(--muted)"/></marker></defs>';
    // connectors
    function ln(a, b) { s += '<line x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '" stroke="var(--muted)" stroke-width="1.5" marker-end="url(#ar)"/>'; }
    ln(center('PC', 'r'), center('MAR', 'l'));
    ln(center('MAR', 'r'), [BOXES.MEM[0], 41]);
    ln([BOXES.MEM[0] + BOXES.MEM[2], 41], center('MDR', 'l'));
    ln(center('MDR', 'r'), center('IR', 'l'));
    ln(center('IR', 'b'), center('CU', 't'));
    ln([BOXES.MDR[0] + 43, 62], [BOXES.ALU[0] + 100, 190]);
    ln(center('ACC', 'r'), center('ALU', 'l'));
    ln(center('ACC', 'l'), center('OUT', 'r'));
    // boxes
    Object.keys(BOXES).forEach(function (id) {
      var b = BOXES[id];
      s += '<g id="box-' + id + '"><rect x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="7" fill="var(--panel)" stroke="var(--line)" stroke-width="1.6"/>';
      s += '<text x="' + (b[0] + b[2] / 2) + '" y="' + (b[1] + (b[4] ? 22 : 25)) + '" text-anchor="middle" font-size="14" font-weight="700" fill="var(--ink)">' + (b[4] || id) + '</text>';
      if (!b[4] || id === 'MEM') s += '<text class="bv" x="' + (b[0] + b[2] / 2) + '" y="' + (b[1] + b[3] - 7) + '" text-anchor="middle" font-size="11.5" font-family="var(--mono)" fill="var(--muted)"></text>';
      s += '</g>';
    });
    s += '<text x="460" y="108" font-size="11" fill="var(--muted)">operand / data path</text>';
    s += '</svg>';
    $('diagram').innerHTML = s;
  }
  function paintDiagram(rec) {
    Object.keys(BOXES).forEach(function (id) {
      var g = $('box-' + id), r = g.querySelector('rect'), t = g.querySelector('.bv');
      var on = rec && rec.touch.indexOf(id) >= 0;
      r.setAttribute('stroke', on ? 'var(--accent)' : 'var(--line)');
      r.setAttribute('fill', on ? 'var(--accent-soft)' : 'var(--panel)');
      r.setAttribute('stroke-width', on ? '2.6' : '1.6');
      if (t) {
        var v = '';
        if (cpu.reg.hasOwnProperty(id)) v = fmtShort(cpu.reg[id]);
        if (id === 'MEM') v = rec && on ? 'addr ' + cpu.reg.MAR : '';
        t.textContent = v;
      }
    });
    $('diagNote').textContent = rec ? '- highlighted: ' + rec.touch.join(', ') : '';
  }
  function fmtShort(n) {
    var b = Number($('base').value);
    if (b === 2) return '0x' + n.toString(16).toUpperCase();   // binary is too wide for the small boxes
    return fmt(n);
  }

  /* ------------------------------------------------------------- rendering */
  function renderRegs(prev) {
    var rows = '<tr><th>Register</th><th class="num">Value</th></tr>';
    ['PC', 'MAR', 'MDR', 'IR', 'ACC'].forEach(function (r) {
      var changed = prev && prev.reg[r] !== cpu.reg[r];
      rows += '<tr' + (changed ? ' style="background:var(--warn-soft)"' : '') + '><td>' + r + '</td><td class="num">' + fmt(cpu.reg[r]) +
        (r === 'IR' && cpu.reg.IR ? ' <span class="muted">(' + S.disassemble(cpu.reg.IR) + ')</span>' : '') + '</td></tr>';
    });
    rows += '<tr><td>Flags</td><td class="num">Z=' + cpu.flags.Z + ' N=' + cpu.flags.N + ' C=' + cpu.flags.C + '</td></tr>';
    $('regs').innerHTML = rows;
  }

  function renderMem() {
    var h = '<tr><th class="num">Addr</th><th class="num">Content</th><th>Reads as</th></tr>';
    var nextPC = cpu.reg.PC;
    for (var a = 0; a < cpu.memSize; a++) {
      var style = '';
      if (a === nextPC && !cpu.halted) style = ' style="background:var(--accent-soft)"';
      if (cpu.lastWrite === a) style = ' style="background:var(--good-soft)"';
      var label = '';
      Object.keys(labels).forEach(function (k) { if (labels[k] === a) label = k; });
      h += '<tr id="m' + a + '"' + style + '><td class="num">' + a + '</td><td class="num">' + fmt(cpu.mem[a]) + '</td><td>' +
        (a === nextPC && !cpu.halted ? '<b>PC &rarr;</b> ' : '') + (label ? '<span class="pill purple">' + label + '</span> ' : '') +
        '<span class="muted mono">' + (a >= progLen ? '-' : dataAddrs.indexOf(a) >= 0 ? 'data' : S.disassemble(cpu.mem[a])) + '</span></td></tr>';
    }
    $('memTable').innerHTML = h;
    var row = $('m' + Math.min(nextPC, cpu.memSize - 1)), wrap = $('memWrap');
    if (row) wrap.scrollTop = Math.max(0, row.offsetTop - wrap.clientHeight / 2);
  }

  function renderStatus() {
    ['FETCH', 'DECODE', 'EXECUTE'].forEach(function (p) {
      var el = document.querySelector('[data-p="' + p + '"]');
      var on = !!lastRec && lastRec.phase === p;
      el.className = 'pill ' + (on ? 'good' : 'info');
      el.style.opacity = on ? 1 : .55;
    });
    $('haltPill').style.display = cpu.halted ? '' : 'none';
    $('haltPill').textContent = cpu.error ? 'HALTED: ' + cpu.error : 'HALTED';
    $('stCycles').textContent = cpu.cycles;
    $('stInstr').textContent = cpu.instrCount;
    $('stCpi').textContent = cpu.instrCount ? (cpu.cycles / cpu.instrCount).toFixed(2) : '-';
    $('outPort').textContent = cpu.output.length ? cpu.output.map(function (v) { return v; }).join(', ') : '(nothing sent yet)';
    var dis = cpu.halted;
    $('btnMicro').disabled = dis; $('btnInstr').disabled = dis; $('btnRun').disabled = dis && !timer;
  }

  function logRec(rec, pcBefore) {
    var div = document.createElement('div');
    var instrNo = rec.instrIndex + 1;
    var tag = rec.phase === 'FETCH' ? 'F' : rec.phase === 'DECODE' ? 'D' : 'E';
    div.textContent = '#' + instrNo + ' ' + tag + '  ' + rec.label + (rec.cost > 1 ? '   [' + rec.cost + ' cycles]' : '');
    div.title = rec.text;
    var old = $('log').querySelector('.cur'); if (old) old.className = '';
    div.className = 'cur';
    $('log').appendChild(div);
    $('log').scrollTop = $('log').scrollHeight;
    if (rec.endsInstruction) {
      var sep = document.createElement('div');
      sep.style.cssText = 'border-bottom:1px solid var(--line);margin:3px 0';
      $('log').appendChild(sep);
    }
  }

  function afterStep(recs) {
    if (!recs || !recs.length) { renderStatus(); return; }
    recs.forEach(logRec);
    lastRec = recs[recs.length - 1];
    var prev = recs[0].before;
    renderRegs(prev);
    renderMem();
    paintDiagram(lastRec);
    var txt = recs.length === 1
      ? '<b>' + lastRec.phase + '</b> &middot; <span class="mono">' + lastRec.label + '</span><br>' + lastRec.text
      : '<b>Whole instruction finished</b> (' + recs.length + ' micro-operations). Last one: <span class="mono">' + lastRec.label + '</span><br>' + lastRec.text;
    $('explain').innerHTML = txt;
    renderStatus();
  }

  /* --------------------------------------------------------------- actions */
  function stop() { if (timer) { clearInterval(timer); timer = null; $('btnRun').textContent = 'Run'; } }

  function loadProgram() {
    stop();
    var size = Number($('memSize').value), lat = Number($('memLat').value);
    var asm = S.assemble($('src').value, size);
    if (asm.errors.length) { $('asmErr').textContent = asm.errors.join('\n'); return; }
    $('asmErr').textContent = '';
    labels = asm.labels; dataAddrs = asm.dataAddrs; progLen = asm.words.length;
    cpu = new S.CPU({ memSize: size, memLatency: lat });
    cpu.load(asm.words);
    resetView();
  }
  function resetView() {
    lastRec = null;
    $('log').innerHTML = '';
    $('explain').innerHTML = '<span class="muted">Press <b>Step micro-operation</b> to watch the first FETCH begin.</span>';
    renderRegs(null); renderMem(); paintDiagram(null); renderStatus();
  }
  function restart() { stop(); cpu.softReset(); resetView(); }

  function runTick() {
    if (cpu.halted) { stop(); renderStatus(); return; }
    var r = cpu.stepMicro();
    if (r) afterStep([r]);
    if (cpu.halted) stop();
    renderStatus();
  }

  function init() {
    var sel = $('sample');
    Object.keys(S.SAMPLES).forEach(function (k) { var o = document.createElement('option'); o.textContent = k; sel.appendChild(o); });
    $('src').value = S.SAMPLES[sel.value];
    buildDiagram();

    sel.onchange = function () { $('src').value = S.SAMPLES[sel.value]; loadProgram(); };
    $('btnLoad').onclick = loadProgram;
    $('memSize').onchange = loadProgram;
    $('memLat').onchange = loadProgram;
    $('base').onchange = function () { renderRegs(null); renderMem(); paintDiagram(lastRec); };
    $('btnMicro').onclick = function () { stop(); var r = cpu.stepMicro(); if (r) afterStep([r]); renderStatus(); };
    $('btnInstr').onclick = function () { stop(); afterStep(cpu.stepInstruction()); };
    $('btnReset').onclick = restart;
    $('btnRun').onclick = function () {
      if (timer) { stop(); return; }
      $('btnRun').textContent = 'Pause';
      var ms = 1100 - Number($('speed').value) * 100;
      timer = setInterval(runTick, ms);
    };
    $('speed').oninput = function () {
      if (timer) { clearInterval(timer); timer = setInterval(runTick, 1100 - Number($('speed').value) * 100); }
    };
    loadProgram();
  }
  init();
})();
