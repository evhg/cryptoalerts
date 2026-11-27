// Who deposited to / withdrew from stUSDS in a block range: node took.mjs <from> <to>
import { createPublicClient, http, formatUnits, parseAbiItem, hexToString } from 'viem'
import { mainnet } from 'viem/chains'
const c = createPublicClient({ chain: mainnet, transport: http('https://mainnet.gateway.tenderly.co') })
const ST = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'
const from = BigInt(process.argv[2]), to = BigInt(process.argv[3] ?? process.argv[2])
const dep = parseAbiItem('event Deposit(address indexed sender, address indexed owner, uint256 assets, uint256 shares)')
const wd = parseAbiItem('event Withdraw(address indexed sender, address indexed receiver, address indexed owner, uint256 assets, uint256 shares)')
const logs = [...(await c.getLogs({ address: ST, event: dep, fromBlock: from, toBlock: to })).map((l) => ({ ...l, k: 'deposit ' })), ...(await c.getLogs({ address: ST, event: wd, fromBlock: from, toBlock: to })).map((l) => ({ ...l, k: 'withdraw' }))]
logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.transactionIndex - b.transactionIndex)
const seen = new Map()
for (const l of logs) {
  if (!seen.has(l.blockNumber)) { const b = await c.getBlock({ blockNumber: l.blockNumber }); seen.set(l.blockNumber, hexToString(b.extraData).replace(/[^\x20-\x7e]/g, '')) }
  const t = await c.getTransaction({ hash: l.transactionHash })
  console.log(l.blockNumber, JSON.stringify(seen.get(l.blockNumber)), 'idx', l.transactionIndex, l.k, Number(formatUnits(l.args.assets, 18)).toFixed(2), 'USDS | tx from', t.from, 'to', t.to, '| owner', l.args.owner, l.transactionHash)
}
if (!logs.length) console.log('no deposits or withdrawals in', from, '-', to)
