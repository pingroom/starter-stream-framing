# Stream framing with PingRoom

Reassemble length-prefixed frames from captured binary chunks after the stream owner selects the documented framing convention in PingRoom. Code exports opaque payload bytes, absolute byte offsets and diagnostics for incomplete or invalid trailing data. Use it when a capture or test adapter preserves arbitrary read boundaries and the framing preset needs confirmation.

The starter writes local JSON. It opens no sockets, decodes no payload fields and changes no source bytes.

## Try it offline

Choose **Use this template**, clone your copy and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo applies three presets and Unknown to one fictional capture. Tests and demos use published `@pingroom/sdk` **0.8.0** with local mock transports. After installation they require no credentials or network and send no live pings. Dependencies are pinned in the lockfile; `.npmrc` requests a 14-day release age where supported by npm.

## Prepare retained chunks

```sh
cp examples/chunks.json chunks.json
cp config.example.json config.json
npm run preview
```

| Field | Contract |
| --- | --- |
| `streamId` | 1–40 characters: lowercase letter first, then lowercase letters, digits, `_` or `-`. |
| `title`, `context` | Nonempty trimmed single lines, at most 40 and 80 UTF-16 code units. Identify the capture and the documentation that defines its framing. |
| `chunks` | 1–256 ordered strings of lowercase hex byte pairs, at most 16,384 bytes in total. Empty strings are allowed. Preserve capture order; chunk boundaries have no framing meaning. |

Preview rejects odd-length hex, uppercase hex, separators, sparse arrays, extra fields, malformed Unicode and control/format characters. The input file is limited to 64 KiB and the Question to 500 UTF-16 units. An empty stream such as `chunks: [""]` is valid. Preview shows the exact Question without connecting.

The owner selects the convention documented for the source protocol:

| Choice | Prefix | Declared length |
| --- | --- | --- |
| `u16be` | Unsigned 2-byte big-endian integer | Payload bytes only; excludes the prefix. |
| `u16le` | Unsigned 2-byte little-endian integer | Payload bytes only; excludes the prefix. |
| `u32be-total` | Unsigned 4-byte big-endian integer | Total frame bytes, including the four-byte prefix. |

For every preset, payloads may be empty but must not exceed 4,096 bytes. At most 512 complete frames are accepted. A `u32be-total` length below four is invalid. Values are read unsigned; a high-bit 32-bit value fails the payload limit without allocating the advertised size.

## Connect and choose a preset

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Approve pairing and grant a standard private room containing the stream owner, with room-list and Question create/read permissions. Verify the person in the app and enter their exact member UUID and a descriptive label in `config.json`. Names alone do not establish identity.

For an existing granted connection, copy `.env.example` to `.env` and set **both** `PINGROOM_TOKEN` and `PINGROOM_ROOM`. Blank or partial pairs are rejected; credential sources cannot be mixed.

```sh
npm run preview
npm start
# After the owner answers:
npm start
npm run export
```

Each run creates at most one direct, 15-minute Question or reads the original Question once. The choices are the three presets or **Unknown**. PingRoom receives the stream ID, title/context, owner UUID and input/stream/policy hashes. Hex chunks and payload bytes stay local; keep sensitive capture contents out of title/context.

Missing, Unknown, expired, cancelled, invalid or misattributed answers withhold decoding and export, even for an empty stream. There is no background polling or replacement Question.

## Read the result

```sh
npm run status
npm run report
npm run export
```

These commands are local and need no credentials. `report` writes `.framing/report.json`, including incomplete answer evidence. A known preset allows `export` to write private `.framing/frames.json`, including the original input, attributed choice, hashes, frames and diagnostics.

Top-level `status: "complete"` means the owner made a verified preset selection. Check **`analysis.parseStatus`** separately: `complete` means all bytes form accepted frames, `truncated` means the capture ends mid-prefix or mid-payload, and `invalid` means a length or frame limit failed. Export permits truncated and invalid captures for inspection; a completed Question does not make the capture valid.

Each frame has a zero-based `index`, `frameStart`, `payloadStart`, `payloadEnd`, `frameEnd`, `declaredLength`, `payloadLength` and lowercase `payloadHex`. Offsets are absolute bytes in the concatenated stream; upper ends are exclusive. Empty payloads have equal payload start/end. `parsedBytes` is the end of the last complete frame. `unparsedBytes` includes the entire incomplete or invalid trailing frame and any later bytes; the two counts sum to `totalBytes`.

`diagnostic` is null for complete streams. Otherwise its `offset` is the start of the first failing frame, with one code:

- `truncated_prefix`: available and missing prefix bytes.
- `truncated_payload`: declared length, expected/available payload bytes and missing bytes.
- `length_below_prefix`: a total length smaller than its own prefix.
- `payload_limit`: a payload length above 4,096 bytes.
- `frame_limit`: a 513th frame prefix after 512 complete frames.

The decoder stops at the first error, retaining earlier frames and counting the remaining input as unparsed. Payloads stay opaque, including bytes that resemble prefixes. Protocol autodetection, checksums, compression, encryption, payload interpretation and automatic repair are outside this starter.

## Adapt and resume

Export ordered byte chunks from your capture or test tool as lowercase hex. Keep the original capture while the owner checks the framing documentation. `decodeChunks(input, preset)` in `src/model.js` is the pure batch API; CLI export also requires the attributed owner selection.

For incremental input within the same bounds:

```js
import { createFrameDecoder } from './src/model.js';

const decoder = createFrameDecoder('u16be');
decoder.push('00');
decoder.push('03aabb');
decoder.push('cc');
const result = decoder.finish(); // one payload: aabbcc
```

`push(hexChunk)` accumulates frames internally and returns no frames. `finish()` seals the decoder and returns a detached snapshot; repeated calls return equivalent snapshots, and further pushes fail. Validate and persist the complete capture in your adapter before using the starter's CLI workflow. No live capture, deployment or external-action adapter is included.

Changing chunk boundaries preserves decoded frames and `streamHash`. `sourceHash` also binds the original chunk segmentation and metadata, so a saved session rejects a repartitioned input. All limits are application rules. Increase them only with matching file/output bounds and tests.

Real chunks, configuration, credentials, state and outputs are ignored by Git. Keep `.framing/` and `.pingroom/` private on persistent storage. Writes are atomic under a local lock; changed input, owner, room or credentials cannot reuse the session. A refused export preserves older output; consume it only after a successful export with the expected source/policy hashes and the parse status your adapter accepts.

A lost creation response leaves `create_unknown` and never triggers an automatic resend:

```sh
npm run status
npm run find-id
npm run recover -- EXACT-QUESTION-UUID
```

Recover only the original Question. An empty bounded search does not prove creation failed. Resolve or revoke uncertain/expired pairing in Connected Agents before archiving its pending record. Remove a stale `.lock` only after confirming its process stopped. Keep the original input and session while resolving uncertainty.

Run commands serially. Exit codes: `0` complete selection/local result; `1` invalid setup/evidence or refused export; `2` incomplete/Unknown/failed answer; `3` ready/pending/interrupted; `4` uncertain creation. Local status/report return 0 even for incomplete states; inspect their JSON. Truncated/invalid framing results also return 0 after a known selection; inspect `analysis.parseStatus` before consuming frames.

Tests compare the incremental decoder with an independent contiguous-buffer oracle on all split positions for sample frames and 1,800 seeded valid, truncated and arbitrary streams. They cover unsigned lengths, zero payloads, bounds, provenance, recovery, pairing and real CLI subprocesses. GitHub Actions checks Node.js 22 and 24. Live phone delivery is not tested. MIT licensed.
