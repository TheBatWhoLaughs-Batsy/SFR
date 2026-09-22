// Streams a capture session to a folder as rolling JSON-lines segments.
//
//   <session dir>/session.json            manifest, rewritten on every segment close and on demand
//   <session dir>/stream_000001.jsonl     one JSON object per line, in arrival order
//   <session dir>/stream_000002.jsonl ...
//
// MEMORY is bounded by one open segment: a segment is closed once it holds SEGMENT_MAX_BYTES
// or is SEGMENT_MAX_MS old, and its text is released as soon as its final write succeeds.
// Nothing else is retained, however long the session runs.
//
// CRASH SAFETY. The open segment is rewritten whole on every flush (the caller flushes about
// once a second). The File System Access API writes to a temporary file and swaps it in on
// close(), so every segment on disk is always a complete copy of some earlier moment: a crash
// loses at most the lines since the last flush. Rewriting costs at most one segment per flush,
// which is why segments are capped rather than grown for the whole session.
//
// A write that fails keeps its data and is retried on the next flush. `backlogBytes` reports
// how much is waiting; if the disk stays broken it grows, and the caller should say so loudly.
//
// Works with any object shaped like a FileSystemDirectoryHandle (getFileHandle / createWritable),
// so node can drive it with a fake.

export const SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
export const SEGMENT_MAX_MS = 30_000;

const segName = (i) => `stream_${String(i).padStart(6, '0')}.jsonl`;

async function writeWhole(dir, name, text) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(text);
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch { /* already failed */ }
    throw e;
  }
}

export function createSessionWriter(dir, {
  maxBytes = SEGMENT_MAX_BYTES, maxMs = SEGMENT_MAX_MS, now = () => Date.now(),
} = {}) {
  let index = 0;
  let open = null;          // the segment being appended to
  const unfinished = new Set(); // closed segments whose final write has not succeeded yet
  const segments = [];      // manifest entries, in order
  let chain = Promise.resolve();
  let fileError = null;   // the last side-file (manifest) write, if it failed
  let writtenBytes = 0;
  let writes = 0;
  let lines = 0;

  const newSegment = () => {
    index += 1;
    const entry = { file: segName(index), lines: 0, bytes: 0, first_rx_ms: null, last_rx_ms: null, closed: false };
    segments.push(entry);
    return { entry, parts: [], bytes: 0, dirty: false, queued: false, final: false, openedAt: now(), flushedBytes: 0, error: null };
  };

  const schedule = (seg) => {
    if (seg.queued) return chain;
    seg.queued = true;
    chain = chain.then(async () => {
      seg.queued = false;
      if (!seg.dirty) return;
      if (seg.parts.length > 1) seg.parts = [seg.parts.join('')];
      const text = seg.parts[0] || '';
      const final = seg.final;
      seg.dirty = false;
      try {
        await writeWhole(dir, seg.entry.file, text);
        writtenBytes += text.length - seg.flushedBytes;
        seg.flushedBytes = text.length;
        writes += 1;
        seg.error = null;
        if (final && !seg.dirty) {
          seg.entry.closed = true;
          seg.parts = null;           // release the segment's text
          unfinished.delete(seg);
        }
      } catch (e) {
        seg.dirty = true;
        seg.error = e?.message || String(e);
      }
    });
    return chain;
  };

  const close = (seg) => {
    seg.final = true;
    unfinished.add(seg);
    seg.dirty = true;
    schedule(seg);
  };

  return {
    /** Append one record. Serialised immediately, so later mutation of `obj` cannot change it. */
    append(obj, rxMs = now()) {
      const line = `${JSON.stringify(obj)}\n`;
      if (open && (open.bytes >= maxBytes || rxMs - open.openedAt >= maxMs)) {
        close(open);
        open = null;
      }
      if (!open) open = newSegment();
      open.parts.push(line);
      open.bytes += line.length;
      open.dirty = true;
      const e = open.entry;
      e.lines += 1;
      e.bytes += line.length;
      if (e.first_rx_ms == null) e.first_rx_ms = rxMs;
      e.last_rx_ms = rxMs;
      lines += 1;
      return line.length;
    },
    /** Write every segment with unwritten data (the open one and any whose close failed). */
    flush() {
      for (const seg of unfinished) if (seg.dirty) schedule(seg);
      if (open && open.dirty) schedule(open);
      return chain;
    },
    /** Close the open segment; resolves when every queued write has been attempted. */
    async finish() {
      if (open) { close(open); open = null; }
      for (const seg of unfinished) if (seg.dirty) schedule(seg);
      await chain;
      return unfinished.size === 0;
    },
    /** Whole-file write of a small side file (the manifest), in order with the segments. */
    writeFile(name, text) {
      let ok = false;
      chain = chain.then(async () => {
        try {
          await writeWhole(dir, name, text);
          writes += 1;
          ok = true;
          fileError = null;
        } catch (e) {
          fileError = e?.message || String(e);
        }
      });
      return chain.then(() => ok);
    },
    segments: () => segments.map((s) => ({ ...s })),
    stats() {
      let backlog = 0;
      for (const seg of unfinished) if (seg.parts) backlog += seg.bytes - seg.flushedBytes;
      if (open) backlog += open.bytes - open.flushedBytes;
      // An error stays reported until the write that failed has gone through, even if later
      // writes to other files succeed in the meantime.
      let lastError = fileError;
      for (const seg of [...unfinished, open]) if (seg && seg.error) lastError = seg.error;
      return {
        lines, writes, writtenBytes, backlogBytes: backlog, segments: segments.length,
        openBytes: open ? open.bytes : 0, lastError, unfinished: unfinished.size,
      };
    },
  };
}
