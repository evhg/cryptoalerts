// Checks the pending-transaction decoder against real mainnet transactions.
// Run: deno run --allow-net pending_test.ts
import { formatUnits } from 'npm:viem@2.58.4'
import { createPublicClient, http } from 'npm:viem@2.58.4'
import { mainnet } from 'npm:viem@2.58.4/chains'
import { freedByExact } from './pending.ts'

const RPC = 'https://ethereum-rpc.publicnode.com'
const ARCHIVE = 'https://mainnet.gateway.tenderly.co'
const SAFES = ['0xf65475e74C1Ed6d004d5240b06E3088724dFDA5d', '0xca5183FB9997046fbd9bA8113139bf5a5Af122A0'] as const
const tx = async (hash: string) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionByHash', params: [hash] }) })).json()).result
const block = async (n: number) => (await (await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBlockByNumber', params: ['0x' + n.toString(16), true] }) })).json()).result
const find = async (n: number, prefix: string) => (await block(n)).transactions.find((t: any) => t.hash.startsWith(prefix))

const cases: [string, any, number][] = [
  ["rune.eth Safe execTransaction: approve + wipe 3,000,000 (multiSend)", (await block(26477749)).transactions.find((t: any) => t.to?.toLowerCase() === SAFES[0].toLowerCase()), 3_000_000],
  ['0x99a7 direct engine wipe 30,001', await find(26478867, '0x06eb1b6038'), 30_001.41],
  ['public stUSDS deposit of 120 (our drill)', await tx('0x023fb88a003eae95755aaaae66d88b3dd7e6612fcd05e395f18c3c58ed32f45b'), 120],
  ['0xFe13 repay-and-withdraw through its own contract (nothing to take)', await find(26483420, '0x601d03b63e'), 0],
]
let fail = 0
for (const [name, t, want] of cases) {
  if (!t) { console.log('MISSING', name); fail++; continue }
  // Debt as it was just before the transaction ran.
  const client = createPublicClient({ chain: mainnet, transport: http(ARCHIVE) }) as any
  const at = BigInt(t.blockNumber) - 1n
  const pinned = { ...client, readContract: (a: any) => client.readContract({ ...a, blockNumber: at }) }
  const got = Number(formatUnits(await freedByExact(t, SAFES as any, pinned), 18))
  const ok = Math.abs(got - want) < 1
  if (!ok) fail++
  console.log(ok ? 'PASS' : 'FAIL', name, '->', got.toLocaleString('en-US'))
}
Deno.exit(fail ? 1 : 0)
