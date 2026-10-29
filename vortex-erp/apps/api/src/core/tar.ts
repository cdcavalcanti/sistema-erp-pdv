import { gzipSync } from 'node:zlib';

/** Empacota arquivos em .tar.gz (POSIX ustar) sem dependências externas. */
export function tarGz(files: { name: string; content: Buffer | string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    const header = Buffer.alloc(512, 0);
    const name = Buffer.from(f.name, 'utf8');
    if (name.length > 100) {
      // ustar: prefixo (155) + nome (100)
      const idx = f.name.lastIndexOf('/', 154);
      header.write(f.name.slice(idx + 1), 0, 100, 'utf8');
      header.write(f.name.slice(0, idx), 345, 155, 'utf8');
    } else {
      name.copy(header, 0);
    }
    header.write('0000644\0', 100, 8, 'ascii');
    header.write('0000000\0', 108, 8, 'ascii');
    header.write('0000000\0', 116, 8, 'ascii');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
    header.write('        ', 148, 8, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    let chk = 0;
    for (const b of header) chk += b;
    header.write(`${chk.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(blocks));
}
