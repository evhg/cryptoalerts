import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeAggregate3,
  encodeAggregate3,
  fmtPct,
  fmtUsds,
  hedged,
  isAtOrBelow,
  RAY,
  rpow,
  toSnapshot,
  WAD,
} from '../supabase/functions/stusds-watch/chain.ts'

const word = (v: bigint | number) => BigInt(v).toString(16).padStart(64, '0')

test('encodeAggregate3 matches the canonical ABI encoding', () => {
  // Reference produced with viem's encodeFunctionData for aggregate3.
  const got = encodeAggregate3([
    { target: '0xcA11bde05977b3631167028862bE2a173976CA11', data: '0x42cbb15c' },
    { target: '0x99CD4Ec3f88A45940936F469E4bB72A2A701EEB9', data: '0x01e1d114' },
  ])
  const tuple = (addr: string, sel: string) => addr.padStart(64, '0') + word(1) + word(0x60) + word(4) + sel.padEnd(64, '0')
  const t1 = tuple('ca11bde05977b3631167028862be2a173976ca11', '42cbb15c')
  const t2 = tuple('99cd4ec3f88a45940936f469e4bb72a2a701eeb9', '01e1d114')
  assert.equal(got, '0x82ad56cb' + word(0x20) + word(2) + word(0x40) + word(0x40 + t1.length / 2) + t1 + t2)
})

test('decodeAggregate3 reads success flags and return data', () => {
  const r1 = word(1) + word(0x40) + word(32) + word(1234)
  const r2 = word(0) + word(0x40) + word(0)
  const hex = '0x' + word(0x20) + word(2) + word(0x40) + word(0x40 + r1.length / 2) + r1 + r2
  assert.deepEqual(decodeAggregate3(hex), [
    { success: true, data: word(1234) },
    { success: false, data: '' },
  ])
  assert.throws(() => decodeAggregate3('0x'))
})

test('rpow matches DSS fixed-point compounding', () => {
  assert.equal(rpow(RAY, 12345n), RAY)
  assert.equal(rpow(2n * RAY, 10n), 1024n * RAY)
  assert.equal(rpow(0n, 0n), RAY)
  assert.equal(rpow(0n, 5n), 0n)
  // 1.000000001 per second for a day, value cross-checked on-chain style.
  assert.equal(rpow(1000000001000000000000000000n, 86400n), 1000086403732544294013328711n)
})

const raw = (debtWad: bigint, totalWad: bigint, extra: Partial<Parameters<typeof toSnapshot>[0]> = {}) => ({
  block: 100n,
  timestamp: 1_000n,
  totalAssets: totalWad,
  art: debtWad,
  rate: RAY,
  duty: RAY,
  rho: 1_000n,
  due: 0n,
  ...extra,
})

test('threshold comparison is exact at the boundary', () => {
  const total = 1_000_000n * WAD
  const at = toSnapshot(raw(999_000n * WAD, total))
  assert.equal(at.utilPpm, 999000)
  assert.equal(isAtOrBelow(at, 999000n), true)
  assert.equal(at.availableWad, 1_000n * WAD)

  const justAbove = toSnapshot(raw(999_000n * WAD + 1n, total))
  assert.equal(isAtOrBelow(justAbove, 999000n), false)

  const full = toSnapshot(raw(total + 5n, total))
  assert.equal(full.availableWad, 0n)
  assert.equal(isAtOrBelow(full, 999000n), false)
})

test('debt includes interest accrued since the last drip, and auction Due', () => {
  const total = 1_000_000n * WAD
  // Stored rate says 99.85% utilized, but a day of un-dripped interest at
  // ~0.1%/day pushes it above the 99.9% threshold.
  const stale = toSnapshot(raw(998_500n * WAD, total))
  assert.equal(isAtOrBelow(stale, 999000n), true)
  const accrued = toSnapshot(raw(998_500n * WAD, total, { duty: 1000000011574074074074074074n, timestamp: 87_400n }))
  assert.ok(accrued.utilPpm > 999000)
  assert.equal(isAtOrBelow(accrued, 999000n), false)

  const withDue = toSnapshot(raw(998_500n * WAD, total, { due: 1_000n * WAD * RAY }))
  assert.equal(withDue.utilPpm, 999500)
  assert.throws(() => toSnapshot(raw(1n, 0n)))
})

test('formatting', () => {
  assert.equal(fmtUsds(1234567n * WAD + 999n), '1,234,567')
  assert.equal(fmtUsds(0n), '0')
  assert.equal(fmtPct(999000), '99.900%')
  assert.equal(fmtPct(998999.9), '99.899%')
  assert.equal(fmtPct(999000, 1), '99.9%')
  assert.equal(fmtPct(1000000), '100.000%')
})

test('hedged returns the first success and fails only when all fail', async () => {
  const slow = (v: string, ms: number, fail = false) => () =>
    new Promise<string>((res, rej) => setTimeout(() => (fail ? rej(new Error(v)) : res(v)), ms))
  const fns: Record<string, () => Promise<string>> = { a: slow('a', 200), b: slow('b', 20), c: slow('c', 5, true) }
  assert.equal(await hedged(['a', 'b'], (u) => fns[u](), 50), 'b')
  assert.equal(await hedged(['c', 'a'], (u) => fns[u](), 500), 'a')
  await assert.rejects(hedged(['c', 'c'], (u) => fns[u](), 10))
})
