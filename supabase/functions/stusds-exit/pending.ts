// Decoding of pending transactions for the backrun watch: how much
// withdrawable USDS would a transaction create if it landed?

import { decodeAbiParameters, type Hex, parseAbi, parseUnits, type PublicClient, toFunctionSelector } from 'npm:viem@2.58.4'

const LOCKSTAKE_ENGINE = '0xCe01C90dE7FD1bcFa39e237FE6D8D9F569e8A6a3'
const ST_USDS = '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9'

export const SEL = {
  wipe: toFunctionSelector('wipe(address,uint256,uint256)'),
  wipeAll: toFunctionSelector('wipeAll(address,uint256)'),
  deposit: toFunctionSelector('deposit(uint256,address)'),
  depositRef: toFunctionSelector('deposit(uint256,address,uint16)'),
  mint: toFunctionSelector('mint(uint256,address)'),
  exec: toFunctionSelector('execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)'),
  multiSend: toFunctionSelector('multiSend(bytes)'),
}
export const ALL_DEBT = parseUnits('5000000', 18) // wipeAll placeholder; freedByExact reads the real debt

/** USDS a call to the Lockstake engine would free (0 if it frees nothing). */
export function freedByEngineCall(data: Hex): bigint {
  const sel = data.slice(0, 10)
  if (sel === SEL.wipe) return BigInt('0x' + data.slice(10 + 128, 10 + 192))
  if (sel === SEL.wipeAll) return ALL_DEBT
  return 0n
}

/** Safe multiSend payload: (operation uint8, to address, value uint256, dataLength uint256, data)* packed. */
export function multiSendCalls(data: Hex): { to: Hex; data: Hex }[] {
  const [payload] = decodeAbiParameters([{ type: 'bytes' }], `0x${data.slice(10)}`)
  const h = payload.slice(2)
  const out: { to: Hex; data: Hex }[] = []
  let i = 0
  while (i + 170 <= h.length) {
    const to = `0x${h.slice(i + 2, i + 42)}` as Hex
    const len = Number(BigInt('0x' + h.slice(i + 106, i + 170)))
    out.push({ to, data: `0x${h.slice(i + 170, i + 170 + len * 2)}` as Hex })
    i += 170 + len * 2
  }
  return out
}

/** How much withdrawable USDS a pending transaction would create, by what it calls. */
export function freedBy(tx: any, safes: Hex[]): bigint {
  const to = String(tx.to ?? '').toLowerCase()
  const data = String(tx.input ?? '0x') as Hex
  if (to === LOCKSTAKE_ENGINE.toLowerCase()) return freedByEngineCall(data)
  if (to === ST_USDS.toLowerCase()) {
    const sel = data.slice(0, 10)
    if (sel === SEL.deposit || sel === SEL.depositRef || sel === SEL.mint) return BigInt('0x' + data.slice(10, 74))
    return 0n
  }
  if (safes.some((s) => s.toLowerCase() === to) && data.startsWith(SEL.exec)) {
    try {
      const [innerTo, , innerData] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
        `0x${data.slice(10)}`,
      )
      if (innerTo.toLowerCase() === LOCKSTAKE_ENGINE.toLowerCase()) return freedByEngineCall(innerData)
      if (innerData.startsWith(SEL.multiSend)) {
        return multiSendCalls(innerData).filter((c) => c.to.toLowerCase() === LOCKSTAKE_ENGINE.toLowerCase()).reduce((s, c) => s + freedByEngineCall(c.data), 0n)
      }
    } catch { /* not decodable: ignore */ }
  }
  return 0n
}


/** The (owner, index) of every wipeAll a transaction would run, directly or through a watched Safe. */
function wipeAllTargets(tx: any, safes: Hex[]): { owner: Hex; index: bigint }[] {
  const to = String(tx.to ?? '').toLowerCase()
  const data = String(tx.input ?? '0x') as Hex
  const calls: { to: string; data: Hex }[] = []
  if (to === LOCKSTAKE_ENGINE.toLowerCase()) calls.push({ to, data })
  else if (safes.some((s) => s.toLowerCase() === to) && data.startsWith(SEL.exec)) {
    try {
      const [innerTo, , innerData] = decodeAbiParameters(
        [{ type: 'address' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'bytes' }],
        `0x${data.slice(10)}`,
      )
      if (innerData.startsWith(SEL.multiSend)) calls.push(...multiSendCalls(innerData))
      else calls.push({ to: innerTo, data: innerData })
    } catch { /* ignore */ }
  }
  return calls
    .filter((c) => c.to.toLowerCase() === LOCKSTAKE_ENGINE.toLowerCase() && c.data.startsWith(SEL.wipeAll))
    .map((c) => {
      const [owner, index] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], `0x${c.data.slice(10)}`)
      return { owner, index }
    })
}

/** Like freedBy, with each wipeAll valued at that loan's actual current debt. */
export async function freedByExact(tx: any, safes: Hex[], client: PublicClient): Promise<bigint> {
  let freed = freedBy(tx, safes)
  const targets = wipeAllTargets(tx, safes)
  if (!targets.length) return freed
  const ilk = '0x4c534556322d534b592d41000000000000000000000000000000000000000000'
  const [, rate] = await client.readContract({ address: '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B', abi: parseAbi(['function ilks(bytes32) view returns (uint256,uint256,uint256,uint256,uint256)']), functionName: 'ilks', args: [ilk] })
  for (const t of targets) {
    freed -= ALL_DEBT
    const urn = await client.readContract({ address: LOCKSTAKE_ENGINE, abi: parseAbi(['function ownerUrns(address,uint256) view returns (address)']), functionName: 'ownerUrns', args: [t.owner, t.index] })
    const [, art] = await client.readContract({ address: '0x35D1b3F3D7966A1DFe207aa4514C12a259A0492B', abi: parseAbi(['function urns(bytes32,address) view returns (uint256,uint256)']), functionName: 'urns', args: [ilk, urn] })
    freed += (art * rate) / 10n ** 27n
  }
  return freed > 0n ? freed : 0n
}
