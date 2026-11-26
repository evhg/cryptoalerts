// Lean arb (StUsdsArbLite, contracts/src/StUsdsArbLite.sol).
//
// Builders rank competing transactions by what they pay per unit of gas, so this
// contract does the same arb in about a third of the gas: it borrows USDS directly,
// buys with one swap, and tips the builder out of ETH it already holds. It sizes
// itself when it runs, so the same call serves the standing bundle and the routes
// that follow a known transaction.

import { encodeDeployData, encodeFunctionData, getAddress, type Hex, keccak256, parseAbi, parseUnits, type PublicClient } from 'npm:viem@2.58.4'
import { ARB4_CREATION_BYTECODE } from './arb4-bytecode.ts'

export const ARB4_CREATION_HASH = '0x291fa14fcffe55622ba815eeccb9c16d2dd2519f50f90d75ae5520479ea85051'
// A small run uses about 300k. A large one adds the two-step purchase and, when the ETH held cannot cover the tip,
// a swap for the rest: about 900k. The limit is only a ceiling; builders rank on gas actually used.
export const ARB4_GAS_LIMIT = 1_500_000n
export const ARB4_MAX_WEI_PER_USDS = 2n * 10n ** 15n
const WAD = 10n ** 18n
const CURVE_POOL = '0x2C7C98A3b1582D83c43987202aEFf638312478aE' as Hex
const ST_USDS = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9' as Hex

export const arb4Abi = parseAbi([
  'constructor(address profitTo_, address keeper_)',
  'function run(uint256 minShares, uint256 maxSpend, uint256 tipBps, uint256 weiPerUsds, uint256 minNet, uint256 twoStepFrom, uint256 price) returns (uint256 net)',
  'function available() view returns (uint256)',
  'function withdrawEth(uint256 amount)',
  'function keeper() view returns (address)',
  'function profitTo() view returns (address)',
  'event Arb(uint256 available, uint256 spent, uint256 shares, uint256 redeemed, uint256 tipWei, uint256 net)',
])
const viewAbi = parseAbi(['function get_dy(int128 i, int128 j, uint256 dx) view returns (uint256)', 'function convertToAssets(uint256) view returns (uint256)'])

export function arb4DeployData(profitTo: Hex, keeper: Hex): Hex {
  if (keccak256(ARB4_CREATION_BYTECODE as Hex) !== ARB4_CREATION_HASH) throw new Error('arb4 bytecode does not match the tested build')
  return encodeDeployData({ abi: arb4Abi, bytecode: ARB4_CREATION_BYTECODE as Hex, args: [profitTo, keeper] })
}

/** The contract must be byte-for-byte what the tested build deploys with profit going to the main wallet. */
const verified = new Set<string>()
export async function verifyArb4(client: PublicClient, address: Hex, profitTo: Hex, keeper: Hex) {
  const a = getAddress(address)
  if (verified.has(a)) return a
  const [code, expected, onchainKeeper, onchainProfitTo] = await Promise.all([
    client.getCode({ address: a }),
    client.call({ data: arb4DeployData(profitTo, keeper) }).then((r) => r.data),
    client.readContract({ address: a, abi: arb4Abi, functionName: 'keeper' }),
    client.readContract({ address: a, abi: arb4Abi, functionName: 'profitTo' }),
  ])
  if (!code || code !== expected) throw new Error('arb4 contract is not the tested build')
  if (getAddress(onchainProfitTo) !== getAddress(profitTo)) throw new Error('arb4 contract pays someone else')
  if (getAddress(onchainKeeper) !== getAddress(keeper)) throw new Error('arb4 contract has another keeper')
  verified.add(a)
  return a
}

/**
 * What the pool and the vault look like right now: the USDS one stUSDS costs at the pool for a small purchase
 * (a hair under, so a run never buys more than Sky can redeem) and what one stUSDS redeems for.
 */
export async function leanMarket(client: PublicClient): Promise<{ price: bigint; nav: bigint }> {
  const ref = 100n * WAD
  const [dy, nav] = await Promise.all([
    client.readContract({ address: CURVE_POOL, abi: viewAbi, functionName: 'get_dy', args: [0n, 1n, ref] }),
    client.readContract({ address: ST_USDS, abi: viewAbi, functionName: 'convertToAssets', args: [WAD] }),
  ])
  if (dy === 0n) throw new Error('pool gave no quote')
  return { price: (((ref * WAD) / dy) * 9995n) / 10_000n, nav }
}

/** Calldata for one lean run: take whatever is redeemable, give the builder `tipShare` of the profit in ETH. */
export function leanArbData(o: {
  minOpeningUsds: number
  maxSpendUsds: number
  tipShare: number
  ethUsd: number
  minNetUsds: number
  twoStepFromUsds: number
  market: { price: bigint; nav: bigint }
}): Hex {
  const tipBps = BigInt(Math.max(0, Math.min(9995, Math.round(o.tipShare * 10_000))))
  let weiPerUsds = o.ethUsd > 0 ? BigInt(Math.floor(1e18 / o.ethUsd)) : 0n
  if (weiPerUsds > ARB4_MAX_WEI_PER_USDS) weiPerUsds = ARB4_MAX_WEI_PER_USDS
  const minShares = (parseUnits(String(o.minOpeningUsds), 18) * WAD) / o.market.nav
  return encodeFunctionData({
    abi: arb4Abi,
    functionName: 'run',
    args: [minShares, parseUnits(String(o.maxSpendUsds), 18), tipBps, weiPerUsds, parseUnits(String(o.minNetUsds), 18), parseUnits(String(o.twoStepFromUsds), 18), o.market.price],
  })
}
