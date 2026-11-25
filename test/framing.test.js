import test from 'node:test';
import assert from 'node:assert/strict';
import { createFrameDecoder, decodeChunks, validateInput, framingPlan, requestFor, previewInput, hash, POLICY_HASH, LIMITS, PRESETS } from '../src/model.js';
import { CONFIG, PARTICIPANT, id } from '../src/mock.js';
const inputFor = chunks => ({ streamId: 'fixture', title: 'Retained capture', context: 'Use the documented length convention.', chunks });
const decode = (chunks, preset) => { const decoder = createFrameDecoder(preset); chunks.forEach(chunk => decoder.push(chunk)); return decoder.finish(); };
const encode = (payloads, preset) => Buffer.concat(payloads.map(payload => {
  const bytes = Buffer.from(payload, 'hex'), prefix = Buffer.alloc(preset === 'u32be-total' ? 4 : 2);
  if (preset === 'u16be') prefix.writeUInt16BE(bytes.length);
  else if (preset === 'u16le') prefix.writeUInt16LE(bytes.length);
  else prefix.writeUInt32BE(bytes.length + 4);
  return Buffer.concat([prefix, bytes]);
}));

// Independent contiguous-buffer oracle uses Buffer readers and slices, not incremental state.
function oracle(hex, preset) {
  const bytes = Buffer.from(hex, 'hex'), width = preset === 'u32be-total' ? 4 : 2, frames = [];
  let offset = 0, diagnostic = null, parseStatus = 'complete';
  while (offset < bytes.length) {
    if (bytes.length - offset < width) { parseStatus = 'truncated'; diagnostic = { code: 'truncated_prefix', offset, availableBytes: bytes.length - offset, missingBytes: width - (bytes.length - offset) }; break; }
    const declaredLength = preset === 'u16be' ? bytes.readUInt16BE(offset) : preset === 'u16le' ? bytes.readUInt16LE(offset) : bytes.readUInt32BE(offset);
    const size = declaredLength - (preset === 'u32be-total' ? width : 0);
    let code = null;
    if (size < 0) code = 'length_below_prefix'; else if (size > 4096) code = 'payload_limit'; else if (frames.length >= 512) code = 'frame_limit';
    if (code) { parseStatus = 'invalid'; diagnostic = { code, offset, declaredLength, payloadLength: size }; break; }
    if (bytes.length - offset - width < size) {
      parseStatus = 'truncated'; diagnostic = { code: 'truncated_payload', offset, payloadStart: offset + width, declaredLength,
        expectedPayloadBytes: size, availablePayloadBytes: bytes.length - offset - width, missingBytes: size - (bytes.length - offset - width) }; break;
    }
    const end = offset + width + size;
    frames.push({ index: frames.length, frameStart: offset, payloadStart: offset + width, payloadEnd: end, frameEnd: end,
      declaredLength, payloadLength: size, payloadHex: bytes.subarray(offset + width, end).toString('hex') });
    offset = end;
  }
  return { preset, parseStatus, totalBytes: bytes.length, parsedBytes: offset, unparsedBytes: bytes.length - offset, frameCount: frames.length, frames, diagnostic };
}
function verify(chunks, preset) {
  const actual = decode(chunks, preset); assert.deepEqual(actual, oracle(chunks.join(''), preset));
  assert.equal(actual.parsedBytes + actual.unparsedBytes, actual.totalBytes); return actual;
}
test('documented presets reassemble opaque bytes and half-open absolute offsets', () => {
  for (const preset of Object.keys(PRESETS)) {
    const bytes = encode(['0001feff', '', 'abcd'], preset), result = verify([bytes.toString('hex')], preset);
    assert.equal(result.parseStatus, 'complete'); assert.deepEqual(result.frames.map(f => f.payloadHex), ['0001feff', '', 'abcd']);
    const width = preset === 'u32be-total' ? 4 : 2;
    assert.equal(result.frames[1].frameStart, width + 4); assert.equal(result.frames[2].frameEnd, 3 * width + 6);
  }
});
test('every possible byte split across prefix and payload gives the same frames', () => {
  for (const preset of Object.keys(PRESETS)) {
    const bytes = encode(['aabbcc', '', 'dd'], preset), expected = oracle(bytes.toString('hex'), preset);
    for (let a = 0; a <= bytes.length; a++) for (let b = a; b <= bytes.length; b++) {
      const chunks = ['', bytes.subarray(0,a).toString('hex'), '', bytes.subarray(a,b).toString('hex'), bytes.subarray(b).toString('hex'), ''];
      assert.deepEqual(decode(chunks,preset), expected);
    }
  }
});
test('seeded valid frames, arbitrary chunk partitions and random byte streams match the contiguous oracle', () => {
  let seed = 20261125; const random = n => { seed = (Math.imul(seed,1664525)+1013904223)>>>0; return seed%n; };
  let cases = 0;
  for (const preset of Object.keys(PRESETS)) for (let i = 0; i < 200; i++) {
    const payloads = Array.from({length:random(10)}, () => Buffer.from(Array.from({length:random(40)}, () => random(256))).toString('hex'));
    const valid = encode(payloads,preset), arbitrary = Buffer.from(Array.from({length:random(150)}, () => random(256)));
    for (const bytes of [valid, valid.subarray(0,random(valid.length+1)), arbitrary]) {
      const chunks = []; let at = 0;
      while (at < bytes.length) { if (random(4)===0) chunks.push(''); const end=Math.min(bytes.length,at+1+random(15));chunks.push(bytes.subarray(at,end).toString('hex'));at=end; }
      if (!chunks.length) chunks.push(''); verify(chunks,preset); cases++;
    }
  }
  assert.equal(cases,1800);
});
test('all prefixes and payload truncation positions preserve complete earlier frames', () => {
  for (const preset of Object.keys(PRESETS)) {
    const earlier = encode(['aa'],preset), last = encode(['10203040'],preset);
    for (let n=1;n<last.length;n++) {
      const hex=Buffer.concat([earlier,last.subarray(0,n)]).toString('hex'), result=verify([hex],preset);
      assert.equal(result.parseStatus,'truncated');assert.equal(result.frameCount,1);assert.equal(result.diagnostic.offset,earlier.length);assert.equal(result.parsedBytes,earlier.length);
    }
  }
});
test('unsigned 32-bit high-bit lengths never wrap negative or allocate advertised payloads', () => {
  for (const declared of [0x80000000,0xffffffff]) {
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(declared);
    const result=verify([prefix.toString('hex'),'00000004'], 'u32be-total');
    assert.equal(result.parseStatus,'invalid');assert.equal(result.diagnostic.declaredLength,declared);assert.equal(result.diagnostic.payloadLength,declared-4);assert.equal(result.diagnostic.code,'payload_limit');assert.equal(result.frames.length,0);
  }
});
test('total lengths zero through three are invalid while total four encodes an empty frame', () => {
  for (let declared=0;declared<4;declared++) { const p=Buffer.alloc(4);p.writeUInt32BE(declared);const result=verify([p.toString('hex')],'u32be-total');assert.equal(result.diagnostic.code,'length_below_prefix');assert.equal(result.diagnostic.offset,0); }
  for (const preset of Object.keys(PRESETS)) { const result=verify([encode([''],preset).toString('hex')],preset);assert.equal(result.parseStatus,'complete');assert.equal(result.frames[0].payloadLength,0); }
});
test('payload length 4096 succeeds and 4097 is rejected immediately without resynchronization', () => {
  for (const preset of Object.keys(PRESETS)) {
    const maximum=verify([encode(['ff'.repeat(4096)],preset).toString('hex')],preset);assert.equal(maximum.frames[0].payloadLength,4096);
    const bad=Buffer.concat([encode(['aa'],preset),encode(['00'.repeat(4097)],preset),encode(['bb'],preset)]);
    const result=verify([bad.subarray(0,7).toString('hex'),bad.subarray(7).toString('hex')],preset);
    assert.equal(result.parseStatus,'invalid');assert.equal(result.diagnostic.code,'payload_limit');assert.deepEqual(result.frames.map(f=>f.payloadHex),['aa']);assert.equal(result.diagnostic.offset,encode(['aa'],preset).length);
  }
});
test('exactly 512 empty frames succeed; a 513th frame stops with its byte offset', () => {
  for (const preset of Object.keys(PRESETS)) {
    const maximum=verify([encode(Array(512).fill(''),preset).toString('hex')],preset);assert.equal(maximum.parseStatus,'complete');assert.equal(maximum.frameCount,512);
    const overflow=verify([encode(Array(513).fill(''),preset).toString('hex')],preset);assert.equal(overflow.parseStatus,'invalid');assert.equal(overflow.diagnostic.code,'frame_limit');assert.equal(overflow.diagnostic.offset,maximum.totalBytes);assert.equal(overflow.frameCount,512);
  }
});
test('empty chunks and stream are valid; finish is detached and seals further pushes', () => {
  const decoder=createFrameDecoder('u16be');decoder.push('');assert.equal(decoder.finish().totalBytes,0);assert.throws(()=>decoder.push('0000'),/sealed/);
  const second=createFrameDecoder('u16be');second.push('0001ff');const result=second.finish();result.frames[0].payloadHex='';assert.equal(second.finish().frames[0].payloadHex,'ff');
  assert.deepEqual(decode(['','',''],'u16be'),oracle('','u16be'));
});
test('invalid chunk pushes leave decoder state unchanged and total input bounds are enforced', () => {
  const decoder=createFrameDecoder('u16be');decoder.push('00');
  for (const invalid of ['x','f','AA','00\n',null,12,{},'00'.repeat(16385)]) assert.throws(()=>decoder.push(invalid));
  decoder.push('01ff');assert.deepEqual(decoder.finish(),oracle('0001ff','u16be'));
  const count=createFrameDecoder('u16be');for(let i=0;i<256;i++)count.push('');assert.throws(()=>count.push(''),/limit/);
  const size=createFrameDecoder('u16be');size.push('ff'.repeat(16384));assert.throws(()=>size.push('00'),/limit/);assert.equal(size.finish().totalBytes,16384);
});
test('maximum byte input and maximum frame export remain below the 1 MiB output bound', () => {
  const payloads=[...Array(3).fill('ab'.repeat(4096)),'cd'.repeat(4080)];
  const hex=encode(payloads,'u32be-total').toString('hex');assert.equal(hex.length/2,LIMITS.bytes);
  const input=inputFor([hex]),analysis=decodeChunks(input,'u32be-total');assert.equal(analysis.parseStatus,'complete');assert.equal(analysis.totalBytes,16384);
  for(const source of [input,inputFor([encode(Array(512).fill(''),'u32be-total').toString('hex')])]) {
    const result={source,analysis:decodeChunks(source,'u32be-total')};assert.ok(Buffer.byteLength(JSON.stringify(result,null,2))+10000<1024*1024);
  }
});
test('invalid input shape, metadata, sparse arrays, non-hex and out-of-bounds input are rejected without coercion', () => {
  for (const chunks of [[],Array(257).fill(''),Array(1),[null],[0],[true],[{}],['f'],['FF'],['00 '],['00\n'],['00'.repeat(16385)],null])assert.throws(()=>validateInput(inputFor(chunks)));
  for(const mutate of [i=>{i.extra=true;},i=>{i.streamId='bad\n';},i=>{i.title=' ';},i=>{i.context='x'.repeat(81);},i=>{i.title='\ud800';}]){const input=inputFor(['']);mutate(input);assert.throws(()=>validateInput(input));}
  assert.throws(()=>createFrameDecoder('unknown'));assert.throws(()=>createFrameDecoder(2));
});
test('owner Question defines conventions, stays bounded and omits opaque bytes', () => {
  const input=inputFor(['decafbad']),request=requestFor(input,CONFIG,'framing',id(1));
  assert.match(request.prompt,/excluding prefix/);assert.match(request.prompt,/including prefix/);assert.equal(request.target_user_id,PARTICIPANT);assert.equal(request.data.stream_hash,hash('decafbad'));assert.ok(!JSON.stringify(request).includes('decafbad'));
  assert.deepEqual(request.options.map(o=>o.value),['u16be','u16le','u32be-total','unknown']);assert.ok(request.prompt.length<=500);
  const maximum={...input,streamId:'x'.repeat(40),title:'x'.repeat(40),context:'x'.repeat(80)};assert.ok(previewInput(maximum,CONFIG).question.prompt.length<=500);
});
test('missing and Unknown withhold decoding; known malformed result has completed selection with invalid parseStatus', () => {
  const input=inputFor(['00000000']);assert.equal(framingPlan(input,null).status,'incomplete');assert.equal(framingPlan(input,'unknown').analysis,null);
  const result=framingPlan(input,'u32be-total');assert.equal(result.status,'complete');assert.equal(result.analysis.parseStatus,'invalid');assert.throws(()=>framingPlan(input,'U16BE'));
});
test('input provenance binds chunk boundaries while content hash and decoding are partition invariant', () => {
  const input=inputFor(['0001ff']),split=inputFor(['00','01','ff']),before=structuredClone(input);
  const a=decodeChunks(input,'u16be'),b=decodeChunks(split,'u16be');assert.deepEqual(a.frames,b.frames);assert.equal(a.streamHash,b.streamHash);assert.notEqual(a.sourceHash,b.sourceHash);
  assert.equal(a.policyHash,POLICY_HASH);assert.equal(a.sourceChanged,false);assert.deepEqual(input,before);
});
