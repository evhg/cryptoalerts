import { createPublicClient, http, hexToString } from 'viem'
import { mainnet } from 'viem/chains'
const c = createPublicClient({ chain: mainnet, transport: http('https://mainnet.gateway.tenderly.co') })
const head = await c.getBlockNumber(); const N = 1500; const count = {}
const nums = Array.from({ length: N }, (_, i) => head - BigInt(i))
for (let i = 0; i < nums.length; i += 50) {
  const bs = await Promise.all(nums.slice(i, i + 50).map((n) => c.getBlock({ blockNumber: n }).catch(() => null)))
  for (const b of bs) { if (!b) continue; let t = hexToString(b.extraData).replace(/[^\x20-\x7e]/g, '').trim().toLowerCase(); const k = t.includes('titan') ? 'Titan' : t.includes('buildernet') ? 'BuilderNet' : t.includes('quasar') ? 'Quasar' : t.includes('eureka') ? 'Eureka' : t.includes('bombora') ? 'bombora' : t.includes('beaver') ? 'beaverbuild' : t.includes('rsync') ? 'rsync' : t.includes('ethgas') ? 'ETHGas' : 'other / built by the validator itself'; count[k] = (count[k] ?? 0) + 1 }
}
const tot = Object.values(count).reduce((a, b) => a + b, 0)
for (const [k, v] of Object.entries(count).sort((a, b) => b[1] - a[1])) console.log(k.padEnd(40), String(v).padStart(5), (100 * v / tot).toFixed(1) + '%')
console.log('blocks', tot, '(about', (tot * 12 / 3600).toFixed(1), 'hours)')
