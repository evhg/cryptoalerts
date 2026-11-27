const RPC='https://ethereum-rpc.publicnode.com'
const rpc=async(m,p)=>{const r=await fetch(RPC,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:m,params:p})});return (await r.json()).result}
const head=parseInt(await rpc('eth_blockNumber',[]),16)
const logs=await rpc('eth_getLogs',[{address:'0xa2ed66b89e6676de9a4f4d2201c4fdee1c1d212f',fromBlock:'0x'+(head-60).toString(16),toBlock:'latest'}])
console.log('head',head,'probe events in last 60 blocks:',logs.length)
for(const l of logs){const blk=await rpc('eth_getBlockByNumber',[l.blockNumber,false]);console.log(parseInt(l.blockNumber,16),'idx',parseInt(l.transactionIndex,16),l.topics[0].slice(0,10),l.transactionHash,Buffer.from(blk.extraData.slice(2),'hex').toString().replace(/[^\x20-\x7e]/g,'.'))}
console.log('probe ETH',Number(BigInt(await rpc('eth_getBalance',['0xa2ed66b89e6676de9a4f4d2201c4fdee1c1d212f','latest'])))/1e18)
