import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}



export const LIMITS = Object.freeze({ chunks: 256, bytes: 16384, payloadBytes: 4096, frames: 512 });
export const PRESETS = Object.freeze({
  u16be: Object.freeze({ width: 2, endian: 'big', includesPrefix: false }),
  u16le: Object.freeze({ width: 2, endian: 'little', includesPrefix: false }),
  'u32be-total': Object.freeze({ width: 4, endian: 'big', includesPrefix: true }),
});
export const POLICY = Object.freeze({ name: 'length-prefixed-frames-v1',
  presets: 'u16be and u16le are unsigned 2-byte payload lengths; u32be-total is an unsigned 4-byte big-endian total length including its prefix',
  bounds: LIMITS,
  offsets: 'zero-based byte offsets in concatenated chunk order; all upper ends are exclusive',
  recovery: 'stop at the first invalid or incomplete frame; never scan ahead for a plausible prefix',
  payload: 'opaque bytes exported as lowercase hex; zero-length payloads are permitted',
  selection: 'one named owner declares the documented preset; Unknown withholds decoding',
  excluded: 'protocol autodetection, checksums, compression, encryption, payload parsing and live sockets' });
export const POLICY_HASH = hash(POLICY);
const CHOICES = Object.freeze(Object.keys(PRESETS));
const promptFor = input => `${input.title}\n${input.context}\nWhich documented framing preset applies to ${input.streamId}?\nu16be/u16le: unsigned 2-byte big/little-endian payload length, excluding prefix.\nu32be-total: unsigned 4-byte big-endian total length, including prefix.\nUnknown if unverified. Bytes stay local.`;
function validHex(value) {
  return typeof value === 'string' && value.length <= LIMITS.bytes * 2 && /^(?:[0-9a-f]{2})*$(?![\s\S])/.test(value);
}
export function validateInput(input) {
  if (!keys(input, ['streamId', 'title', 'context', 'chunks']) || !word(input.streamId)
    || !line(input.title, 40) || !line(input.context, 80) || !Array.isArray(input.chunks)
    || input.chunks.length < 1 || input.chunks.length > LIMITS.chunks) throw new Error('Supply stream metadata and one to 256 ordered lowercase hex chunks.');
  let bytes = 0;
  const chunks = Array.from(input.chunks, chunk => {
    if (!validHex(chunk)) throw new Error('Each chunk must be complete lowercase hex byte pairs, with no separators.');
    bytes += chunk.length / 2;
    if (bytes > LIMITS.bytes) throw new Error('The complete stream exceeds 16384 bytes.');
    return chunk;
  });
  const result = { streamId: input.streamId, title: input.title, context: input.context, chunks };
  if (promptFor(result).length > 500) throw new Error('Framing Question exceeds 500 UTF-16 units.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact stream owner UUID and label.');
  return structuredClone(config);
}
export const itemsFor = input => { validateInput(input); return [{ id: 'framing' }]; };
export function requestFor(rawInput, config, itemId, attemptId) {
  const input = validateInput(rawInput); validateConfig(config);
  if (itemId !== 'framing' || !isId(attemptId)) throw new Error('Invalid framing selection or attempt.');
  const key = `framing-${attemptId}`;
  return { prompt: promptFor(input), context: `To ${config.participant.id}`,
    options: [{ value: 'u16be', label: 'u16be: payload length', style: 'default' }, { value: 'u16le', label: 'u16le: payload length', style: 'default' },
      { value: 'u32be-total', label: 'u32be-total: total length', style: 'default' }, { value: 'unknown', label: 'Unknown', style: 'default' }],
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), stream_hash: hash(input.chunks.join('')), policy_hash: POLICY_HASH, item_id: itemId, attempt_id: attemptId }, idempotencyKey: key };
}
export function previewInput(rawInput, config) {
  const input = validateInput(rawInput), request = requestFor(input, config, 'framing', '01990000-0000-7000-8000-000000000001');
  const { correlation_id, idempotencyKey, data, ...question } = request;
  return { source: input, sourceHash: hash(input), policy: POLICY, policyHash: POLICY_HASH, question,
    note: 'Attempt UUID, correlation ID and input/stream/policy hashes are added when the session creates its Question.' };
}

/** Incremental bounded decoder. push accepts one hex chunk; finish seals and returns a detached result. */
export function createFrameDecoder(presetId) {
  if (!CHOICES.includes(presetId)) throw new Error('Choose a documented framing preset before decoding.');
  const preset = PRESETS[presetId], frames = [];
  let header = [], payload = [], payloadLength = null, declaredLength = null;
  let received = 0, consumed = 0, frameStart = 0, chunkCount = 0, diagnostic = null, sealed = null;
  const emit = () => {
    frames.push({ index: frames.length, frameStart, payloadStart: frameStart + preset.width,
      payloadEnd: consumed, frameEnd: consumed, declaredLength, payloadLength, payloadHex: Buffer.from(payload).toString('hex') });
    frameStart = consumed; header = []; payload = []; payloadLength = null; declaredLength = null;
  };
  return {
    push(chunk) {
      if (sealed !== null) throw new Error('Decoder is sealed; create a new decoder for another stream.');
      if (!validHex(chunk)) throw new Error('Chunk must contain complete lowercase hex byte pairs.');
      if (chunkCount + 1 > LIMITS.chunks || received + chunk.length / 2 > LIMITS.bytes) throw new Error('Decoder input exceeds its chunk or byte limit.');
      chunkCount++; received += chunk.length / 2;
      for (const byte of Buffer.from(chunk, 'hex')) {
        if (diagnostic !== null) break;
        consumed++;
        if (payloadLength === null) {
          header.push(byte);
          if (header.length !== preset.width) continue;
          declaredLength = preset.endian === 'big' ? header.reduce((n, b) => n * 256 + b, 0)
            : header.reduce((n, b, i) => n + b * 256 ** i, 0);
          payloadLength = declaredLength - (preset.includesPrefix ? preset.width : 0);
          let code = null;
          if (payloadLength < 0) code = 'length_below_prefix';
          else if (payloadLength > LIMITS.payloadBytes) code = 'payload_limit';
          else if (frames.length >= LIMITS.frames) code = 'frame_limit';
          if (code !== null) diagnostic = { code, offset: frameStart, declaredLength, payloadLength };
          else if (payloadLength === 0) emit();
        } else {
          payload.push(byte);
          if (payload.length === payloadLength) emit();
        }
      }
    },
    finish() {
      if (sealed === null) {
        let parseStatus = diagnostic === null ? 'complete' : 'invalid';
        if (diagnostic === null && header.length > 0) {
          parseStatus = 'truncated';
          diagnostic = payloadLength === null ? { code: 'truncated_prefix', offset: frameStart, availableBytes: header.length, missingBytes: preset.width - header.length }
            : { code: 'truncated_payload', offset: frameStart, payloadStart: frameStart + preset.width, declaredLength,
              expectedPayloadBytes: payloadLength, availablePayloadBytes: payload.length, missingBytes: payloadLength - payload.length };
        }
        sealed = { preset: presetId, parseStatus, totalBytes: received, parsedBytes: frameStart, unparsedBytes: received - frameStart,
          frameCount: frames.length, frames, diagnostic };
      }
      return structuredClone(sealed);
    },
  };
}
export function decodeChunks(rawInput, presetId) {
  const input = validateInput(rawInput), decoder = createFrameDecoder(presetId);
  for (const chunk of input.chunks) decoder.push(chunk);
  return { ...decoder.finish(), sourceHash: hash(input), streamHash: hash(input.chunks.join('')), policyHash: POLICY_HASH, sourceChanged: false };
}
export function framingPlan(rawInput, choice) {
  const input = validateInput(rawInput);
  if (choice !== null && choice !== 'unknown' && !CHOICES.includes(choice)) throw new Error('Supply a documented preset, Unknown or a missing selection.');
  return { status: choice === null ? 'incomplete' : choice === 'unknown' ? 'unknown' : 'complete', analysis: choice === null || choice === 'unknown' ? null : decodeChunks(input, choice) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || !/^[0-9a-f]{64}$(?![\s\S])/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > itemsFor(input).length || iso(state.startedAt) !== state.startedAt) throw new Error('Invalid state or changed chunk stream. Restore the original input and configuration.');
  validateConfig(state.config);
  const items = itemsFor(input), ids = new Set(), questionIds = new Set(); let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'itemId', 'createdAt', 'request', 'questionId', 'status', 'observation']) || !isId(attempt.id) || ids.has(attempt.id)
      || attempt.itemId !== items[index].id || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.itemId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) throw new Error('Invalid saved framing selection or order.');
    ids.add(attempt.id); previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId); validateObservation(attempt.observation, attempt.status, attempt.request);
      if (attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates its saved creation intent.');
      previous = attempt.observation.checkedAt;
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS) throw new Error('Question predates its saved creation intent.');
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) throw new Error('Only the last confirmation may have an active Question.');
  }
  return state;
}




export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const attempt = state.attempts[0], answer = attempt?.observation?.answer;
  const answers = [{ itemId: 'framing', status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
    choice: answer?.value ?? null, label: answer?.label ?? null, questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
    responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null, askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null }];
  const calculation = framingPlan(input, answers[0].choice);
  const status = ['create_unknown', 'pending'].includes(answers[0].status) ? answers[0].status : answers[0].status === 'unasked' ? 'ready' : calculation.status;
  return { version: 1, streamId: input.streamId, sourceHash: hash(input), source: input, policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, configHash: hash(state.config), answers, ...calculation, status };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some((option) => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved framing selection evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered framing selections must not contain framing selection evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || (q.is_handoff !== undefined && q.is_handoff !== false)
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || (q.results !== undefined && q.results !== null) || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || Array.from(q.options).some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label
      || (option?.primary !== undefined && option.primary !== false) || (option?.destructive !== undefined && option.destructive !== false))) throw new Error('Question does not match the saved configuration, room, or reviewer.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id
        || !request.options.some((option) => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
