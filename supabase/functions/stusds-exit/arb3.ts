// Self-sizing arb (StUsdsArbAuto, contracts/src/StUsdsArbAuto.sol).
//
// The contract looks at how much USDS is withdrawable at the moment it runs and
// sizes the trade itself, so one signed transaction can wait in every block and
// only goes through when liquidity is there. Used for the standing arb bundle.

import { encodeDeployData, encodeFunctionData, getAddress, type Hex, keccak256, parseAbi, parseUnits, type PublicClient } from 'npm:viem@2.58.4'
import { ARB3_CREATION_BYTECODE } from './arb3-bytecode.ts'

export const ARB3_CREATION_HASH = '0xc5e948a6cf647356e666ec0271893aa8db6bc538665b0d636a8ce146e05266a3'
export const ARB3_GAS_LIMIT = 2_500_000n // two purchases, the redemption and the tip conversion use about 1.3M

export const arb3Abi = parseAbi([
  'constructor(address profitTo_, address keeper_)',
  'function run(uint256 minAvail, uint256 maxSpend, uint256 tipBps, uint256 minNet, uint256 refineMin) returns (uint256 net)',
  'function available() view returns (uint256)',
  'function keeper() view returns (address)',
  'function profitTo() view returns (address)',
  'event Arb(uint256 available, uint256 spent, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net)',
])

export function arb3DeployData(profitTo: Hex, keeper: Hex): Hex {
  if (keccak256(ARB3_CREATION_BYTECODE as Hex) !== ARB3_CREATION_HASH) throw new Error('arb3 bytecode does not match the tested build')
  return encodeDeployData({ abi: arb3Abi, bytecode: ARB3_CREATION_BYTECODE as Hex, args: [profitTo, keeper] })
}

/** The contract must be byte-for-byte what the tested build deploys with profit going to the main wallet. */
const verified = new Set<string>()
export async function verifyArb3(client: PublicClient, address: Hex, profitTo: Hex, keeper: Hex) {
  const a = getAddress(address)
  if (verified.has(a)) return a
  const [code, expected, onchainKeeper, onchainProfitTo] = await Promise.all([
    client.getCode({ address: a }),
    client.call({ data: arb3DeployData(profitTo, keeper) }).then((r) => r.data),
    client.readContract({ address: a, abi: arb3Abi, functionName: 'keeper' }),
    client.readContract({ address: a, abi: arb3Abi, functionName: 'profitTo' }),
  ])
  if (!code || code !== expected) throw new Error('arb3 contract is not the tested build')
  if (getAddress(onchainProfitTo) !== getAddress(profitTo)) throw new Error('arb3 contract pays someone else')
  if (getAddress(onchainKeeper) !== getAddress(keeper)) throw new Error('arb3 contract has another keeper')
  verified.add(a)
  return a
}

/** Calldata for one standing run: take whatever is withdrawable, give the builder `tipShare` of the profit. */
export function standingArbData(o: { minOpeningUsds: number; maxSpendUsds: number; tipShare: number; minNetUsds: number }): Hex {
  const tipBps = BigInt(Math.max(0, Math.min(9995, Math.round(o.tipShare * 10_000))))
  return encodeFunctionData({
    abi: arb3Abi,
    functionName: 'run',
    args: [parseUnits(String(o.minOpeningUsds), 18), parseUnits(String(o.maxSpendUsds), 18), tipBps, parseUnits(String(o.minNetUsds), 18), parseUnits('20', 18)],
  })
}
