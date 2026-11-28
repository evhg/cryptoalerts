const rpc = 'https://eth.drpc.org';
const call = async (method, params) => { const j = await (await fetch(rpc, {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})})).json(); if (j.error) throw new Error(method+' '+JSON.stringify(j.error)); return j.result; };
const list = {
 '27Nov 100': '0x8c9f92e4d44083df8d87ab16230a77e62f50e26cdecd3d468cb8f64512bf4ea1',
 '27Nov 33380': '0xe0bba8305d99e7307658278e02b94df870dfd46c328f15fcd270c01ab9735ff7',
 '24Nov 13950': '0x7725bd8e4f35e8d96bd0219da99131fc47cc0dfd6ba3ba8d5a312fb9726ebe34',
 '24Nov 20000': '0xf1f90e491033e1d02e04d65cdcf8775bd4c18a656583a5fe65b7d4b561cc043b',
 '23Nov 30001': '0x06eb1b60388a6405eb6a1640f7e622c0e25c278c05994a18bd49ba8b7db4e072',
};
const f = (w) => (Number(BigInt(w))/1e18).toFixed(6);
for (const [name, h] of Object.entries(list)) {
  const t = await call('eth_getTransactionByHash', [h]);
  const b = await call('eth_getBlockByNumber', [t.blockNumber, true]);
  const idx = parseInt(t.transactionIndex);
  const traces = await call('trace_block', [t.blockNumber]);
  console.log(`\n${name} block ${parseInt(t.blockNumber)} builder ${b.miner.slice(0,10)} sender ${t.from.slice(0,10)} nonce ${parseInt(t.nonce)} gasLimit ${parseInt(t.gas)} type ${t.type}`);
  for (const i of [idx+1, idx+2]) {
    const x = b.transactions[i]; if (!x) continue;
    const r = await call('eth_getTransactionReceipt', [x.hash]);
    const fee = BigInt(r.gasUsed) * (BigInt(r.effectiveGasPrice) - BigInt(b.baseFeePerGas));
    const cb = traces.filter(c => c.transactionHash === x.hash && c.type === 'call' && BigInt(c.action.value) > 0n).map(c => `${f(c.action.value)}->${c.action.to.slice(0,10)}`);
    console.log(`  idx ${i}: from ${x.from.slice(0,10)} to ${x.to?.slice(0,10)} value ${f(x.value)} gasUsed ${parseInt(r.gasUsed)} prioFee ${f(fee)} ETH; ETH moves: ${cb.join(', ') || 'none'}`);
  }
  // any plain ETH transfers from the builder in the block
  const fromBuilder = b.transactions.filter(x => x.from.toLowerCase() === b.miner.toLowerCase()).map(x => `idx ${parseInt(x.transactionIndex)} ${f(x.value)}->${x.to?.slice(0,10)}`);
  console.log('  txs sent by the builder address:', fromBuilder.join('; ') || 'none');
}
