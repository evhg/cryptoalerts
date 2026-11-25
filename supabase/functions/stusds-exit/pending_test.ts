// Checks the pending-transaction screen against real mainnet transactions.
// Run: deno run --allow-net pending_test.ts
import { amountHint, isCandidate, rebuildRaw } from './pending.ts'

const RPC = 'https://ethereum-rpc.publicnode.com'
const call = async (method: string, params: unknown[]) =>
  (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()).result
const tx = (hash: string) => call('eth_getTransactionByHash', [hash])

// [what it is, transaction, should it be screened in, USDS amount readable directly (or null)]
const cases: [string, string, boolean, number | null][] = [
  ['direct engine wipe 10,000', '0x3bbca31aebe9cbddb668616840a2503b05e080fe4403f5488ce03d2e6a257526', true, 10_000],
  ['engine multicall with a wipe (35,553)', '0xbc7573c76c92e064cfc5b73dc8cd1a388b4d36622fef418d267f498fa6f212ba', true, null],
  ['engine wipeAll (76,110)', '0x961158a61a34ee0abf0fc5024c553fb4f8cffb1a214a3ec83f531e954c7f160e', true, null],
  ['ERC-4337 handleOps repaying 7,500', '0xa0672000b3fb097bd3cba8415105bf086a4325b790daba08ebd0a2939084367f', true, null],
  ['EIP-7702 batch repaying 100,017', '0xf7b611622a02d54258a4fe275b3aea839db6b0a2d7e22a2d9b3d03eb64d5c7d6', true, null],
  ["rune.eth's Safe executing approve + wipe 3,000,000", '0x599bbdd79c63cca8064eb125cf2ce03700d435d7689ff9f043341b6495bc6bfe', true, null],
  ['direct stUSDS deposit of 120', '0x023fb88a003eae95755aaaae66d88b3dd7e6612fcd05e395f18c3c58ed32f45b', true, 120],
  ['EIP-7702 batch depositing 3,662', '0xc484627feecd32723c8a5e0cfdd192a2045a11a5b4982691b2e922cc52064c16', true, null],
  ["a borrower's own repay-and-withdraw contract (nothing left to take)", '0x601d03b63e', false, null],
]

let fail = 0
for (const [name, hash, want, amount] of cases) {
  let t = hash.length === 66 ? await tx(hash) : null
  if (!t) {
    // Short hash: look it up in its block (26483420).
    const b = await call('eth_getBlockByNumber', ['0x' + (26483420).toString(16), true])
    t = b.transactions.find((x: any) => x.hash.startsWith(hash))
  }
  if (!t) { console.log('MISSING', name); fail++; continue }
  const got = isCandidate(t)
  const hint = amountHint(t)
  const hintOk = amount === null ? true : hint !== null && Math.abs(Number(hint / 10n ** 18n) - amount) <= 1
  const rebuilt = rebuildRaw(t)
  const rebuildOk = rebuilt !== null || parseInt(t.type, 16) > 2
  const ok = got === want && hintOk && rebuildOk
  if (!ok) fail++
  console.log(ok ? 'PASS' : 'FAIL', name, '| screened in:', got, '| amount hint:', hint === null ? 'simulate' : Number(hint / 10n ** 18n), '| raw rebuilt:', rebuilt !== null ? 'yes' : `no (type ${parseInt(t.type, 16)})`)
}
// A deposit through a router that never names stUSDS in its calldata is not screened in; say so rather than fail.
const router = await tx('0x916fd9ecb0d911e64013cf034a2eaf5efdca8a95c7b9444040ef9716f257136a')
console.log('INFO deposit via a third-party router screened in:', isCandidate(router), '(such deposits are caught at the end of the block instead)')
Deno.exit(fail ? 1 : 0)
