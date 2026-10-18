import fs from 'node:fs'

const [, , asarPath, innerPath, outPath] = process.argv
const fd = fs.openSync(asarPath, 'r')
const sizeBuf = Buffer.alloc(8)
fs.readSync(fd, sizeBuf, 0, 8, 0)
const headerBufLength = sizeBuf.readUInt32LE(4)
const headerBuf = Buffer.alloc(headerBufLength)
fs.readSync(fd, headerBuf, 0, headerBufLength, 8)
const stringLen = headerBuf.readUInt32LE(4)
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + stringLen))

const parts = innerPath.replace(/^[/\\]+/, '').split(/[/\\]+/)
let node = header
for (const part of parts) node = node?.files?.[part]
if (!node) {
  console.error('not found in archive:', innerPath)
  process.exit(1)
}
const size = Number(node.size)
const off = Number(node.offset)
const base = 8 + headerBufLength
const buf = Buffer.alloc(size)
fs.readSync(fd, buf, 0, size, base + off)
fs.writeFileSync(outPath, buf)
console.log(JSON.stringify({ innerPath, size, offset: off, base, firstBytes: buf.subarray(0, 40).toString('utf8') }))
