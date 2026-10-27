// Raw-mode compression uses the browser's native deflate so there is nothing
// to ship. The receiver inflates with DecompressionStream('deflate-raw').

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export const deflateRaw = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflateRaw = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('deflate-raw'));
