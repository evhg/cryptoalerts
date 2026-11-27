import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'
const c = createPublicClient({ chain: mainnet, transport: http('https://eth.drpc.org') })
const start = await c.getBlockNumber(); const want = start + BigInt(process.argv[2] ?? 6)
for (;;) { const n = await c.getBlockNumber().catch(() => 0n); if (n >= want) { console.log('block', n); break } await new Promise((r) => setTimeout(r, 3000)) }
