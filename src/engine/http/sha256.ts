// FIPS 180-4 SHA-256, incremental so hashing never materializes an entire file.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private readonly words = new Uint32Array(64);
  private buffered = 0;
  private length = 0;
  private finished = false;

  update(bytes: Uint8Array): void {
    if (this.finished) throw new Error("SHA-256 already finalized");
    this.length += bytes.length;
    let pos = 0;
    if (this.buffered) {
      const count = Math.min(64 - this.buffered, bytes.length);
      this.block.set(bytes.subarray(0, count), this.buffered);
      this.buffered += count;
      pos += count;
      if (this.buffered === 64) { this.compress(this.block, 0); this.buffered = 0; }
    }
    while (pos + 64 <= bytes.length) { this.compress(bytes, pos); pos += 64; }
    if (pos < bytes.length) {
      this.block.set(bytes.subarray(pos));
      this.buffered = bytes.length - pos;
    }
  }

  private compress(bytes: Uint8Array, offset: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) | 0;
    }
    // Avoid creating a typed-array iterator for every 64-byte compression block.
    let a=this.state[0]|0, b=this.state[1]|0, c=this.state[2]|0, d=this.state[3]|0;
    let e=this.state[4]|0, f=this.state[5]|0, g=this.state[6]|0, h=this.state[7]|0;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e,6) ^ rotr(e,11) ^ rotr(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a,2) ^ rotr(a,13) ^ rotr(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h=g; g=f; f=e; e=(d+t1)|0; d=c; c=b; b=a; a=(t1+t2)|0;
    }
    this.state[0]+=a; this.state[1]+=b; this.state[2]+=c; this.state[3]+=d;
    this.state[4]+=e; this.state[5]+=f; this.state[6]+=g; this.state[7]+=h;
  }

  digestHex(): string {
    if (this.finished) throw new Error("SHA-256 already finalized");
    const length = this.length;
    const padding = new Uint8Array(this.buffered < 56 ? 64 - this.buffered : 128 - this.buffered);
    padding[0] = 0x80;
    const view = new DataView(padding.buffer);
    view.setUint32(padding.length - 8, Math.floor(length / 0x20000000));
    view.setUint32(padding.length - 4, (length * 8) >>> 0);
    this.update(padding);
    this.finished = true;
    return Array.from(this.state, n => n.toString(16).padStart(8, "0")).join("");
  }
}

export async function hashBlobSha256(blob: Blob, signal: AbortSignal): Promise<string> {
  const hash = new Sha256();
  const reader = blob.stream().getReader();
  let lastYield = performance.now();
  const tasks = new MessageChannel();
  let resumeTask: (() => void) | undefined;
  tasks.port1.onmessage = () => resumeTask?.();
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      // Blob streams can return large blocks; bound each synchronous CPU slice.
      for (let at = 0; at < value.length; at += 256 * 1024) {
        signal.throwIfAborted();
        hash.update(value.subarray(at, at + 256 * 1024));
        if (performance.now() - lastYield > 12) {
          // A posted task yields to UI/cancellation without timer clamping delays.
          await new Promise<void>(resolve => { resumeTask = resolve; tasks.port2.postMessage(null); });
          lastYield = performance.now();
        }
      }
    }
    return hash.digestHex();
  } finally {
    tasks.port1.close(); tasks.port2.close();
    await reader.cancel().catch(() => {});
  }
}
