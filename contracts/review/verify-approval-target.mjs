// Independent check of the contract you are asked to approve.
//
//   npm install solc@0.8.28 viem@2.58.4
//   node verify-approval-target.mjs            (StUsdsExit.sol must sit next to this file)
//
// 1. Compiles StUsdsExit.sol with the official solc 0.8.28 and the exact settings used.
// 2. Downloads the code deployed at the approval target and compares it byte for
//    byte with the compiled code (the two constructor-set immutables masked).
// 3. Prints those immutables (which stUSDS, which owner) and the stored settings.
import { readFileSync } from 'node:fs'
import solc from 'solc'
import { createPublicClient, getAddress, http, parseAbi, formatUnits, formatEther } from 'viem'
import { mainnet } from 'viem/chains'

const TARGET = '0xbF54F2AA78b4c240e34224073aff9E89Cd915897' // spender in the approval
const ST_USDS = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9' // Sky stUSDS (the token being approved)
const OWNER = '0xCD532243888D26791881064E24D4A25FD0041d98' // the wallet signing the approval
const RPC = process.env.RPC_URL || 'https://ethereum-rpc.publicnode.com'

if (solc.version().split('+')[0] !== '0.8.28') throw new Error(`need solc 0.8.28, have ${solc.version()}`)
const input = {
  language: 'Solidity',
  sources: { 'src/StUsdsExit.sol': { content: readFileSync(new URL('./StUsdsExit.sol', import.meta.url), 'utf8') } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: 'cancun',
    metadata: { bytecodeHash: 'none', appendCBOR: false },
    outputSelection: { '*': { '*': ['evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences'] } },
  },
}
const out = JSON.parse(solc.compile(JSON.stringify(input)))
for (const e of out.errors ?? []) if (e.severity === 'error') throw new Error(e.formattedMessage)
const dep = out.contracts['src/StUsdsExit.sol'].StUsdsExit.evm.deployedBytecode
const refs = Object.values(dep.immutableReferences) // [[{start,length}...], [...]]

const client = createPublicClient({ chain: mainnet, transport: http(RPC) })
const onchain = (await client.getCode({ address: TARGET })).slice(2)
const compiled = dep.object
const mask = (hex) => {
  let h = hex
  for (const list of refs) for (const { start, length } of list) h = h.slice(0, start * 2) + '0'.repeat(length * 2) + h.slice((start + length) * 2)
  return h
}
const same = onchain.length === compiled.length && mask(onchain) === mask(compiled)
const word = (start) => onchain.slice(start * 2, start * 2 + 64)
const imm = refs.map((list) => [...new Set(list.map(({ start }) => word(start)))])
console.log('code at target matches the compiled source:', same ? 'YES' : 'NO  <-- do not approve')
console.log('immutable values found:', imm.map((v) => (v.length === 1 ? getAddress('0x' + v[0].slice(24)) : 'INCONSISTENT')))

const abi = parseAbi([
  'function stUsds() view returns (address)', 'function owner() view returns (address)', 'function keeper() view returns (address)',
  'function minAssetsFloor() view returns (uint256)', 'function tipWeiPerUsds() view returns (uint256)', 'function maxTipWei() view returns (uint256)',
])
const r = (fn) => client.readContract({ address: TARGET, abi, functionName: fn })
const [st, owner, keeper, floor, perUsds, maxTip] = await Promise.all(['stUsds', 'owner', 'keeper', 'minAssetsFloor', 'tipWeiPerUsds', 'maxTipWei'].map(r))
console.log('stUsds():', st, st === getAddress(ST_USDS) ? '(Sky stUSDS: OK)' : '<-- NOT stUSDS')
console.log('owner():', owner, owner === getAddress(OWNER) ? '(your wallet: OK, the only possible receiver)' : '<-- NOT your wallet')
console.log('keeper():', keeper, '(the bot key: may trigger a redemption to owner(), nothing else)')
console.log('minAssetsFloor:', formatUnits(floor, 18), 'USDS | tip cap per USDS:', formatEther(perUsds), 'ETH | tip cap per call:', formatEther(maxTip), 'ETH (tips are paid from ETH the caller sends, never from your tokens)')
const tok = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])
const [bal, allowance] = await Promise.all([
  client.readContract({ address: ST_USDS, abi: tok, functionName: 'balanceOf', args: [OWNER] }),
  client.readContract({ address: ST_USDS, abi: tok, functionName: 'allowance', args: [OWNER, TARGET] }),
])
console.log('your stUSDS shares now:', bal.toString(), '| current allowance to target:', allowance.toString())
