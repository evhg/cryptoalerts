// Listen to many public pending-transaction feeds for a while and record when each first shows a transaction.
import { writeFileSync } from 'node:fs'
const urls = ['wss://ethereum-rpc.publicnode.com', 'wss://0xrpc.io/eth', 'wss://eth.drpc.org', 'wss://mainnet.gateway.tenderly.co', 'wss://eth.llamarpc.com', 'wss://ethereum.callstaticrpc.com', 'wss://eth.merkle.io', 'wss://rpc.mevblocker.io', 'wss://eth-mainnet.public.blastapi.io', 'wss://ethereum.blockpi.network/v1/ws/public', 'wss://rpc.ankr.com/eth/ws', 'wss://eth.meowrpc.com', 'wss://ethereum-mainnet.core.chainstack.com/ws', 'wss://eth.rpc.blxrbdn.com', 'wss://1rpc.io/eth']
const secs = Number(process.argv[2] ?? 150)
const feeds = {}
for (const url of urls) {
  const f = feeds[url] = { open: false, err: '', n: 0, seen: {} }
  let ws; try { ws = new WebSocket(url) } catch (e) { f.err = String(e).slice(0, 60); continue }
  ws.onopen = () => { f.open = true; ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newPendingTransactions'] })) }
  ws.onmessage = (m) => { try { const j = JSON.parse(String(m.data)); if (j.error) f.err = JSON.stringify(j.error).slice(0, 80); const r = j?.params?.result; if (r) { const h = typeof r === 'string' ? r : r.hash; if (h && !f.seen[h]) { f.seen[h] = Date.now(); f.n++ } } } catch { } }
  ws.onerror = (e) => { f.err = f.err || String(e?.message ?? 'error').slice(0, 60) }
}
setTimeout(() => { writeFileSync('feedwatch.json', JSON.stringify(feeds)); for (const [u, f] of Object.entries(feeds)) console.log(u.padEnd(46), 'open', String(f.open).padEnd(5), 'hashes', String(f.n).padStart(6), f.err); process.exit(0) }, secs * 1000)
