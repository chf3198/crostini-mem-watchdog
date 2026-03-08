'use strict';
const fs = require('fs');

const RAW = fs.readFileSync('/proc/meminfo', 'utf8');
console.log('meminfo size:', RAW.length, 'bytes,', RAW.split('\n').length - 1, 'lines');

const RUNS = 500000;

const t0 = Date.now();
let rA = [0, 0];
for (let i = 0; i < RUNS; i++) {
    let tot = 0, avail = 0;
    for (const line of RAW.split('\n')) {
        const m = line.match(/^(\w+):\s+(\d+)/);
        if (!m) { continue; }
        if (m[1] === 'MemTotal')     { tot   = parseInt(m[2], 10); }
        if (m[1] === 'MemAvailable') { avail = parseInt(m[2], 10); }
    }
    rA = [tot, avail];
}
const tA = Date.now() - t0;

const t1 = Date.now();
let rB = [0, 0];
for (let i = 0; i < RUNS; i++) {
    const mt = RAW.match(/^MemTotal:\s+(\d+)/m);
    const ma = RAW.match(/^MemAvailable:\s+(\d+)/m);
    rB = [mt ? parseInt(mt[1], 10) : 0, ma ? parseInt(ma[1], 10) : 0];
}
const tB = Date.now() - t1;

const t2 = Date.now();
let rC = [0, 0];
for (let i = 0; i < RUNS; i++) {
    let tot = 0, avail = 0, found = 0;
    for (const line of RAW.split('\n')) {
        if (line.startsWith('MemTotal:'))          { tot   = parseInt(line.slice(10), 10); found++; }
        else if (line.startsWith('MemAvailable:')) { avail = parseInt(line.slice(14), 10); found++; }
        if (found === 2) { break; }
    }
    rC = [tot, avail];
}
const tC = Date.now() - t2;

const t3 = Date.now();
let rD = [0, 0];
for (let i = 0; i < RUNS; i++) {
    let tot = 0, avail = 0;
    let idx = RAW.indexOf('\nMemTotal:');
    if (idx !== -1) { tot   = parseInt(RAW.slice(idx + 10).trimStart(), 10); }
    idx = RAW.indexOf('\nMemAvailable:');
    if (idx !== -1) { avail = parseInt(RAW.slice(idx + 14).trimStart(), 10); }
    rD = [tot, avail];
}
const tD = Date.now() - t3;

console.log('');
console.log('Parsing benchmark x' + RUNS + ' (I/O excluded — single file read):');
console.log('  A current (split+regex full loop):  ', tA, 'ms');
console.log('  B two /m regex on raw string:       ', tB, 'ms');
console.log('  C startsWith + early exit:          ', tC, 'ms');
console.log('  D indexOf + trimStart + parseInt:   ', tD, 'ms');
console.log('');
console.log('Results match:', rA[0]===rB[0] && rB[0]===rC[0] && rC[0]===rD[0],
    '| totalKB:', rA[0]);

function measureAlloc(label, fn, iters) {
    if (typeof gc !== 'undefined') { gc(); }
    const h0 = process.memoryUsage().heapUsed;
    for (let i = 0; i < iters; i++) { fn(); }
    if (typeof gc !== 'undefined') { gc(); }
    const delta = process.memoryUsage().heapUsed - h0;
    console.log(' ', label, '~', Math.round(delta / iters), 'bytes/call');
}

console.log('');
console.log('Heap allocation per call (10k iters):');
measureAlloc('A split+regex full loop:', () => {
    for (const line of RAW.split('\n')) { line.match(/^(\w+):\s+(\d+)/); }
}, 10000);
measureAlloc('B two /m regex:         ', () => {
    RAW.match(/^MemTotal:\s+(\d+)/m);
    RAW.match(/^MemAvailable:\s+(\d+)/m);
}, 10000);
measureAlloc('C startsWith+early exit:', () => {
    let tot = 0, avail = 0, found = 0;
    for (const line of RAW.split('\n')) {
        if (line.startsWith('MemTotal:'))          { tot   = parseInt(line.slice(10), 10); found++; }
        else if (line.startsWith('MemAvailable:')) { avail = parseInt(line.slice(14), 10); found++; }
        if (found === 2) { break; }
    }
    return [tot, avail];
}, 10000);
measureAlloc('D indexOf+trimStart:    ', () => {
    let idx = RAW.indexOf('\nMemAvailable:');
    return parseInt(RAW.slice(idx + 14).trimStart(), 10);
}, 10000);
