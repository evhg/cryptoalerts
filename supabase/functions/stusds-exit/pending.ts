// Pending-transaction screening for the backrun watch.
//
// Repayments and deposits reach the chain in many wrappings (direct calls, the
// engine's multicall, Safe and other smart-account executions, ERC-4337
// bundles, EIP-7702 batches). Rather than decode each wrapper, `isCandidate`
// only asks "could this transaction free stUSDS liquidity?" and the bot then
// measures what it really frees by simulating it.

import { type Hex, keccak256, serializeTransaction } from 'npm:viem@2.58.4'

const ENGINE = 'ce01c90de7fd1bcfa39e237fe6d8d9f569e8a6a3' // Lockstake engine
const ST_USDS = '99cd4ec3f88a45940936f469e4bb72a2a701eeb9'
// 4-byte selectors, hex without 0x
const WIPE = 'c3b6cb4b' // wipe(address,uint256,uint256)
const WIPE_ALL = '6ddb4566' // wipeAll(address,uint256)
const MULTICALL = 'ac9650d8' // multicall(bytes[])
const DEPOSIT = '6e553f65' // deposit(uint256,address)
const DEPOSIT_REF = '9b8d6d38' // deposit(uint256,address,uint16)
const MINT = '94bf804d' // mint(uint256,address)

/** Could this pending transaction free withdrawable USDS in stUSDS? Cheap string checks only. */
export function isCandidate(tx: any): boolean {
  const to = String(tx?.to ?? '').toLowerCase().replace(/^0x/, '')
  const inp = String(tx?.input ?? '').toLowerCase()
  if (inp.length < 10) return false
  const sel = inp.slice(2, 10)
  const body = inp.slice(10)
  if (to === ENGINE) return sel === WIPE || sel === WIPE_ALL || (sel === MULTICALL && (body.includes(WIPE) || body.includes(WIPE_ALL)))
  if (to === ST_USDS) return sel === DEPOSIT || sel === DEPOSIT_REF || sel === MINT
  // Wrapped: the target address and the selector both appear inside the calldata.
  if (body.includes(ENGINE) && (body.includes(WIPE) || body.includes(WIPE_ALL))) return true
  if (body.includes(ST_USDS) && (body.includes(DEPOSIT) || body.includes(DEPOSIT_REF) || body.includes(MINT))) return true
  return false
}

/** The USDS amount when it can be read straight off a direct call; null when it has to be simulated. */
export function amountHint(tx: any): bigint | null {
  const to = String(tx?.to ?? '').toLowerCase().replace(/^0x/, '')
  const inp = String(tx?.input ?? '').toLowerCase()
  const sel = inp.slice(2, 10)
  try {
    if (to === ENGINE && sel === WIPE && inp.length >= 10 + 192) return BigInt('0x' + inp.slice(10 + 128, 10 + 192))
    if (to === ST_USDS && (sel === DEPOSIT || sel === DEPOSIT_REF) && inp.length >= 10 + 64) return BigInt('0x' + inp.slice(10, 74))
  } catch { /* fall through */ }
  return null
}

/**
 * Rebuild the signed raw transaction from a pending-transaction object, so the
 * bot does not need another round trip to fetch it. Returns null for types it
 * does not rebuild (blob, EIP-7702) or if the result does not hash to tx.hash.
 */
export function rebuildRaw(tx: any): Hex | null {
  try {
    const type = parseInt(tx.type, 16)
    const base = { chainId: 1, nonce: parseInt(tx.nonce, 16), gas: BigInt(tx.gas), to: tx.to ?? undefined, value: BigInt(tx.value), data: tx.input as Hex }
    let raw: Hex
    if (type === 2) {
      raw = serializeTransaction(
        { ...base, type: 'eip1559', maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), accessList: tx.accessList ?? [] },
        { r: tx.r, s: tx.s, yParity: parseInt(tx.yParity ?? tx.v, 16) },
      )
    } else if (type === 1) {
      raw = serializeTransaction({ ...base, type: 'eip2930', gasPrice: BigInt(tx.gasPrice), accessList: tx.accessList ?? [] }, { r: tx.r, s: tx.s, yParity: parseInt(tx.yParity ?? tx.v, 16) })
    } else if (type === 0) {
      const v = BigInt(tx.v)
      raw = serializeTransaction({ ...base, type: 'legacy', gasPrice: BigInt(tx.gasPrice), chainId: v >= 35n ? 1 : undefined }, { r: tx.r, s: tx.s, v })
    } else return null
    return keccak256(raw) === tx.hash ? raw : null
  } catch {
    return null
  }
}
